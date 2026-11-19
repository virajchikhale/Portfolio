/**
 * The portfolio's tools: small, READ-ONLY, deterministic. One registry feeds both the agent and the MCP endpoint.
 *
 * Security model (the model's arguments are untrusted input, exactly like a user's message):
 *   - every tool is read-only: nothing here can write, send, delete or fetch a URL;
 *   - arguments are validated strictly (type, length, allowed keys, enum for skill names);
 *   - results are size-capped and treated as DATA by the caller (never as instructions);
 *   - no tool can read a secret, a file path or the system prompt.
 */
import { ACTION_IDS, ACTIONS, MAX_ACTIONS } from "./actions.js";
import type { Settings } from "./config.js";
import { chunkLabel, type Chunk, type Skill } from "./content.js";
import { looksLikeInjection, sanitize } from "./guardrails.js";
import type { ToolSpec } from "./llm/types.js";
import type { Rag } from "./rag.js";
import { Tracer } from "./trace.js";

const MAX_RESULT_CHARS = 3000;
const MAX_ARGS_JSON = 1000;
const PROJECTS_SOURCE = "projects.md";

/** Numbers every chunk cited during ONE run ([1], [2]...) so citations stay consistent across several searches. */
export class SourceBook {
  chunks: Chunk[] = [];

  number(chunk: Chunk): number {
    if (!this.chunks.includes(chunk)) this.chunks.push(chunk);
    return this.chunks.indexOf(chunk) + 1;
  }

  asEvents() {
    return this.chunks.map((c, i) => ({ n: i + 1, label: chunkLabel(c), source: c.source }));
  }
}

export interface ToolContext {
  settings: Settings;
  skills: Record<string, Skill>;
  chunks: Chunk[]; // the whole corpus (for list_projects / get_project)
  rag: Rag | null;
  book: SourceBook;
  actions: string[]; // page actions offered during this run (ids only; see suggest_action)
}

export interface ToolOutput {
  text: string; // what the model (or the MCP client) receives
  data?: Record<string, unknown>; // extra details for the Flow Monitor
  isError?: boolean;
}

/** Bad arguments / unavailable tool. The message is returned to the model so it can correct itself. */
export class ToolError extends Error {}

const clip = (text: string, limit = MAX_RESULT_CHARS): string =>
  text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + "…";

function checkArgs(args: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ToolError("arguments must be an object");
  if (JSON.stringify(args).length > MAX_ARGS_JSON) throw new ToolError("arguments too large");
  const a = args as Record<string, unknown>;
  const extra = Object.keys(a).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolError(`unexpected argument(s): ${extra.sort().join(", ")}`);
  const missing = required.filter((k) => !(k in a));
  if (missing.length) throw new ToolError(`missing argument(s): ${missing.sort().join(", ")}`);
  return a;
}

function strArg(args: Record<string, unknown>, key: string, lo: number, hi: number): string {
  const v = args[key];
  if (typeof v !== "string") throw new ToolError(`'${key}' must be a string`);
  const clean = sanitize(v);
  if (clean.length < lo || clean.length > hi) throw new ToolError(`'${key}' must be ${lo}-${hi} characters`);
  return clean;
}

// ── the tools ───────────────────────────────────────────────────────────────
async function searchPortfolio(ctx: ToolContext, raw: unknown): Promise<ToolOutput> {
  const args = checkArgs(raw, ["query"], ["query"]);
  const query = strArg(args, "query", 2, 200);
  if (looksLikeInjection(query)) throw new ToolError("query rejected");
  if (!ctx.rag) {
    return { text: "Search is unavailable right now (retrieval is switched off). Answer from CORE FACTS only, or say " +
      "you don't have that detail.", data: { query }, isError: true };
  }
  const sub = new Tracer(); // records the retrieval stages so the Flow Monitor can show them inside this tool call
  const hits = await ctx.rag.retrieve(query, ctx.settings, sub);
  const stages = Object.fromEntries(sub.events.filter((e) => e.phase === "end")
    .map((e) => [e.id, { dur: e.dur, ...e.data, status: e.status }]));
  if (!hits.length) {
    return { text: "No relevant sources found for this query. Try different keywords, or tell the user you don't have " +
      "that detail.", data: { query, retrieval: stages, sources: [] } };
  }
  const numbered = hits.map((h) => [ctx.book.number(h.chunk), h] as const);
  const text = numbered.map(([n, h]) => `[${n}] ${chunkLabel(h.chunk)}\n${h.chunk.content}`).join("\n\n");
  return { text: clip(text), data: { query, retrieval: stages,
    sources: numbered.map(([n, h]) => ({ n, label: chunkLabel(h.chunk) })) } };
}

async function loadSkillTool(ctx: ToolContext, raw: unknown): Promise<ToolOutput> {
  const args = checkArgs(raw, ["name"], ["name"]);
  const name = strArg(args, "name", 1, 64);
  const skill = Object.hasOwn(ctx.skills, name) ? ctx.skills[name] : undefined;
  if (!skill) throw new ToolError(`unknown skill '${name}'. Available: ${Object.keys(ctx.skills).sort().join(", ")}`);
  return { text: clip(skill.body), data: { skill: name, chars: skill.body.length } };
}

const projects = (ctx: ToolContext): Chunk[] => ctx.chunks.filter((c) => c.source === PROJECTS_SOURCE);

function firstSentence(text: string, limit = 140): string {
  const first = text.trim().split(". ")[0]!.trim();
  return first.length <= limit ? first : first.slice(0, limit - 1).trimEnd() + "…";
}

async function listProjects(ctx: ToolContext, raw: unknown): Promise<ToolOutput> {
  checkArgs(raw, [], []);
  const items = projects(ctx);
  if (!items.length) return { text: "No projects are listed.", isError: true };
  return { text: clip(items.map((c) => `- ${c.heading}: ${firstSentence(c.content)}`).join("\n")),
    data: { count: items.length, names: items.map((c) => c.heading) } };
}

async function getProject(ctx: ToolContext, raw: unknown): Promise<ToolOutput> {
  const args = checkArgs(raw, ["name"], ["name"]);
  const name = strArg(args, "name", 2, 100).toLowerCase();
  const items = projects(ctx);
  const words = name.replace(/[()]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const scored = items.map((c) => {
    const h = c.heading.toLowerCase();
    return [words.filter((w) => h.includes(w)).length + (h.includes(name) ? 3 : 0), c] as const;
  }).sort((a, b) => b[0] - a[0]);
  if (!scored.length || scored[0]![0] === 0) {
    throw new ToolError("no such project. Available: " + items.map((c) => c.heading).join("; "));
  }
  const chunk = scored[0]![1];
  const n = ctx.book.number(chunk);
  return { text: clip(`[${n}] ${chunkLabel(chunk)}\n${chunk.content}`),
    data: { project: chunk.heading, sources: [{ n, label: chunkLabel(chunk) }] } };
}

/** OFFERS a page action. It changes nothing: the id goes to the page, which shows a button the visitor may click. */
async function suggestAction(ctx: ToolContext, raw: unknown): Promise<ToolOutput> {
  const args = checkArgs(raw, ["id"], ["id"]);
  const id = strArg(args, "id", 1, 40);
  if (!Object.hasOwn(ACTIONS, id)) throw new ToolError(`unknown action '${id}'. Allowed: ${ACTION_IDS.join(", ")}`);
  if (!ctx.actions.includes(id)) {
    if (ctx.actions.length >= MAX_ACTIONS) throw new ToolError(`offer at most ${MAX_ACTIONS} actions per answer`);
    ctx.actions.push(id);
  }
  return { text: `OK. The visitor will see a button to ${ACTIONS[id]}. It has NOT happened and only happens if they click ` +
    "it. Mention it in one short sentence and ask if they would like it; never say it was done.", data: { action: id } };
}

// ── registry ────────────────────────────────────────────────────────────────
export interface Tool {
  spec: ToolSpec;
  run: (ctx: ToolContext, args: unknown) => Promise<ToolOutput>;
  /** Only meaningful inside the chat page (it needs a UI to show a button): not exposed over MCP. */
  agentOnly?: boolean;
}

export function buildTools(skills: Record<string, Skill>): Record<string, Tool> {
  const tools: Tool[] = [
    { spec: {
      name: "search_portfolio",
      description: "Search Viraj's portfolio (resume, experience, education, skills, projects) and return the most relevant " +
        "numbered sources. Call this before answering any factual question about Viraj.",
      parameters: { type: "object", properties: { query: { type: "string",
        description: "What to look for, in plain words (e.g. 'internship at Inorbvict')." } }, required: ["query"] } },
      run: searchPortfolio },
    { spec: {
      name: "load_skill",
      description: "Load the full instructions of one skill. Only call it when a skill in the catalog clearly matches the " +
        "question, and before you answer.",
      parameters: { type: "object", properties: { name: { type: "string", enum: Object.keys(skills).sort(),
        description: "Skill name from the catalog." } }, required: ["name"] } },
      run: loadSkillTool },
    { spec: { name: "list_projects", description: "List all of Viraj's projects with a one-line summary each.",
      parameters: { type: "object", properties: {} } }, run: listProjects },
    { spec: {
      name: "get_project", description: "Get the full description of one project by (part of) its name.",
      parameters: { type: "object", properties: { name: { type: "string",
        description: "Project name, e.g. 'Movie Recommendation'." } }, required: ["name"] } },
      run: getProject },
    { spec: {
      name: "suggest_action",
      description: "Offer the visitor a BUTTON for a page action. It only shows a button: nothing happens unless they click " +
        "it, so never say it was done. Use it sparingly and only when it clearly helps (for example they want a short " +
        "version: readme; they want to see the projects: open-projects). Allowed ids: " +
        ACTION_IDS.map((id) => `${id} (${ACTIONS[id]})`).join("; ") + ".",
      parameters: { type: "object", properties: { id: { type: "string", enum: ACTION_IDS, description: "Action id." } },
        required: ["id"] } },
      run: suggestAction, agentOnly: true },
  ];
  return Object.fromEntries(tools.map((t) => [t.spec.name, t]));
}

/** Run one tool; argument errors become an error result the model can read and fix (never an exception). */
export async function runTool(tool: Tool, ctx: ToolContext, args: unknown): Promise<ToolOutput> {
  try {
    return await tool.run(ctx, args);
  } catch (err) {
    if (err instanceof ToolError) return { text: `Error: ${err.message}`, isError: true };
    throw err;
  }
}
