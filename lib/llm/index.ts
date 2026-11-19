import type { Settings } from "../config.js";
import { FakeClient } from "./fake.js";
import { GeminiClient } from "./gemini.js";
import { OpenAICompatClient } from "./openai.js";
import type { LLMClient } from "./types.js";

export function buildLlm(s: Settings): LLMClient {
  if (s.llmProvider === "fake") return new FakeClient();
  if (s.llmProvider === "gemini") return new GeminiClient(s);
  return new OpenAICompatClient(s);
}

export * from "./types.js";
