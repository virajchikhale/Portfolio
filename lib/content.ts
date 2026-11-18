/** Loads the portfolio's content (markdown corpus + skills) from /content, which Vercel bundles with the functions. */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function contentRoot(): string {
  const candidates = [process.env.CONTENT_DIR, join(process.cwd(), "content"), resolve(import.meta.dirname, "..", "content")];
  const found = candidates.find((p) => p && existsSync(p) && statSync(p).isDirectory());
  if (!found) throw new Error("content/ directory not found");
  return found;
}

// ── skills (OpenClaw / Anthropic Agent Skills style): a directory with SKILL.md and YAML frontmatter ──────────
export interface Skill {
  name: string;
  description: string;
  body: string;
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The frontmatter we use is flat `key: value` lines, so no YAML dependency is needed. */
function parseFrontmatter(src: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of src.split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) meta[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return meta;
}

export function loadSkills(root = join(contentRoot(), "skills")): Record<string, Skill> {
  const skills: Record<string, Skill> = {};
  if (!existsSync(root)) return skills;
  for (const dir of readdirSync(root).sort()) {
    const file = join(root, dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const m = FRONTMATTER.exec(readFileSync(file, "utf8"));
    if (!m) throw new Error(`${file}: missing YAML frontmatter`);
    const meta = parseFrontmatter(m[1]!);
    const { name = "", description = "" } = meta;
    if (!SKILL_NAME.test(name) || name !== dir) {
      throw new Error(`${file}: 'name' must equal the directory name and be kebab-case`);
    }
    if (!description) throw new Error(`${file}: 'description' is required`);
    skills[name] = { name, description, body: m[2]!.trim() };
  }
  return skills;
}

export function catalog(skills: Record<string, Skill>): string {
  return Object.values(skills).map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

// ── chunker: one chunk per `##` section (a coherent topic); long sections split on paragraph boundaries ──────
export interface Chunk {
  source: string; // file name, e.g. experience.md
  title: string; // document title (# heading)
  heading: string; // section title (## heading)
  content: string;
}

export const chunkLabel = (c: Chunk): string => `${c.title} › ${c.heading}`;
// title + heading give the embedding the context a bare paragraph lacks
export const chunkEmbedText = (c: Chunk): string => `${c.title} — ${c.heading}\n${c.content}`;

function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length + 2 > maxChars) {
      parts.push(cur.trim());
      cur = "";
    }
    cur += para + "\n\n";
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function chunkMarkdown(source: string, text: string, maxChars = 1200): Chunk[] {
  const h1 = /^#\s+(.+)$/m.exec(text);
  const title = h1 ? h1[1]!.trim() : source.replace(/\.md$/, "");
  const body = h1 ? text.slice(h1.index + h1[0].length) : text;
  const sections = body.split(/^##\s+(.+)$/m); // [preamble, h2, body, h2, body, ...]
  const chunks: Chunk[] = [];
  const preamble = (sections[0] ?? "").trim();
  if (preamble) for (const p of splitLong(preamble, maxChars)) chunks.push({ source, title, heading: title, content: p });
  for (let i = 1; i < sections.length; i += 2) {
    const content = (sections[i + 1] ?? "").trim();
    if (content) {
      for (const p of splitLong(content, maxChars)) chunks.push({ source, title, heading: sections[i]!.trim(), content: p });
    }
  }
  return chunks;
}

export const CORE_FILE = "core.md"; // always in the system prompt, so it is not retrieved

export function loadCore(dir = join(contentRoot(), "data")): string {
  const p = join(dir, CORE_FILE);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

export function loadChunks(dir = join(contentRoot(), "data"), exclude: string[] = [CORE_FILE]): Chunk[] {
  return readdirSync(dir).filter((f) => f.endsWith(".md") && !exclude.includes(f)).sort()
    .flatMap((f) => chunkMarkdown(f, readFileSync(join(dir, f), "utf8")));
}
