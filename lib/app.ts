/** Builds the shared app state ONCE per warm function instance (settings, LLM client, corpus, retriever). */
import { loadSettings } from "./config.js";
import { loadChunks, loadCore, loadSkills } from "./content.js";
import { buildLlm } from "./llm/index.js";
import { buildAgentPrompt, buildSystemPrompt } from "./prompt.js";
import { buildRag } from "./rag.js";
import { buildTools } from "./tools.js";
import { getKv } from "./kv.js";
import { Telemetry } from "./telemetry.js";
import type { AppState } from "./chat.js";

let cached: Promise<AppState> | undefined;

export async function createState(env: Record<string, string | undefined> = process.env): Promise<AppState> {
  const settings = loadSettings(env);
  const skills = loadSkills();
  const core = loadCore();
  const chunks = loadChunks();
  const llm = buildLlm(settings); // fails fast if the key is missing
  if (env.VERCEL && !getKv().shared) {
    console.warn("No Upstash Redis configured: rate limits and run statistics are per-instance (best effort). " +
      "Add Upstash Redis from the Vercel Marketplace for a shared daily budget.");
  }
  const rag = await buildRag(chunks, settings);
  return {
    settings, llm, skills, chunks, rag,
    ragReason: rag.reason,
    tools: buildTools(skills),
    systemPrompt: buildSystemPrompt(core, skills),
    agentPrompt: buildAgentPrompt(core, skills, settings.agentMaxToolCalls),
  };
}

const RAG_RETRY_MS = 60_000;
let ragRetryAt = 0;

export async function getState(): Promise<AppState> {
  cached ??= createState().catch((err) => {
    cached = undefined; // let the next request retry
    throw err;
  });
  const state = await cached;
  // If embeddings failed at cold start (a transient quota or network blip), retry now and then instead of staying on
  // keyword-only search for the lifetime of this instance.
  if (state.rag?.reason && state.settings.embeddingProvider === "gemini" && Date.now() >= ragRetryAt) {
    ragRetryAt = Date.now() + RAG_RETRY_MS;
    const rag = await buildRag(state.chunks, state.settings);
    if (rag.denseReady) {
      state.rag = rag;
      state.ragReason = null;
    }
  }
  return state;
}

let telemetry: Telemetry | null | undefined;

export function getTelemetry(state: AppState): Telemetry | null {
  if (telemetry === undefined) {
    telemetry = state.settings.telemetryEnabled ? new Telemetry(getKv(), state.settings) : null;
  }
  return telemetry;
}
