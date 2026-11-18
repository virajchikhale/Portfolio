/** Runtime configuration: everything comes from environment variables (Vercel project settings, or .env locally). */
export interface Settings {
  llmProvider: "gemini" | "openai" | "fake";
  llmModel: string;
  geminiApiKey: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmMaxOutputTokens: number;
  llmThinkingBudget: number; // 0 = off, -1 = model default (needed by Pro models)
  llmThinkingLevel: "minimal" | "low" | "medium" | "high" | null;
  llmTemperature: number;
  llmTimeoutS: number;

  embeddingProvider: "gemini" | "none";
  embeddingModel: string;
  embeddingDim: number;
  ragTopK: number;
  ragMinScore: number;

  agentEnabled: boolean;
  agentFallback: boolean;
  agentMaxSteps: number;
  agentMaxToolCalls: number;
  agentToolTimeoutS: number;
  agentTimeoutS: number;

  mcpEnabled: boolean;
  mcpAuthToken: string;
  mcpRateLimitPerMinute: number;
  mcpRateLimitPerDay: number;

  telemetryEnabled: boolean;
  telemetryStoreQuestions: boolean;
  runRetentionDays: number;
  adminToken: string;
  readRateLimitPerMinute: number;

  maxInputChars: number;
  maxHistoryTurns: number;
  rateLimitPerMinute: number;
  rateLimitPerDay: number;
  dailyGlobalRequestBudget: number;
  trustProxyHeaders: boolean;

  corsOrigins: string[];
  environment: "dev" | "prod";
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback = ""): string {
  const v = env[key];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(env: Env, key: string, fallback: number, lo = -Infinity, hi = Infinity): number {
  const raw = str(env, key);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${key} must be a number between ${lo} and ${hi}`);
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = str(env, key).toLowerCase();
  if (raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = str(env, key).toLowerCase() as T;
  if (raw === ("" as T)) return fallback;
  if (!allowed.includes(raw)) throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  return raw;
}

// Cosine scores are not comparable across models, so the "no source for this" cutoff is per model.
// Re-calibrate with `npm run eval:retrieval` after changing the corpus or the embedding model.
const MIN_SCORE: Record<string, number> = { "gemini-embedding-001": 0.6 };

export function loadSettings(env: Env = process.env): Settings {
  const onVercel = Boolean(env.VERCEL);
  const geminiApiKey = str(env, "GEMINI_API_KEY");
  // "local"/"fake" were Python-backend options (fastembed / tests). They have no meaning here, so an old .env keeps
  // working: retrieval just runs on keyword search.
  const rawEmbedding = str(env, "EMBEDDING_PROVIDER").toLowerCase();
  if (rawEmbedding && !["gemini", "none"].includes(rawEmbedding)) {
    console.warn(`EMBEDDING_PROVIDER=${rawEmbedding} is not supported here (use gemini or none): using keyword search only.`);
  }
  const embeddingProvider: "gemini" | "none" = rawEmbedding === "gemini" ? "gemini"
    : rawEmbedding === "" ? (geminiApiKey ? "gemini" : "none") : "none";
  const embeddingModel = str(env, "EMBEDDING_MODEL", "gemini-embedding-001");
  const thinkingLevel = str(env, "LLM_THINKING_LEVEL").toLowerCase();
  return {
    llmProvider: oneOf(env, "LLM_PROVIDER", ["gemini", "openai", "fake"] as const, "gemini"),
    llmModel: str(env, "LLM_MODEL", "gemini-2.5-flash"),
    geminiApiKey,
    llmBaseUrl: str(env, "LLM_BASE_URL", "https://api.groq.com/openai/v1"),
    llmApiKey: str(env, "LLM_API_KEY"),
    llmMaxOutputTokens: num(env, "LLM_MAX_OUTPUT_TOKENS", 1024, 16, 8192),
    llmThinkingBudget: num(env, "LLM_THINKING_BUDGET", 0, -1),
    llmThinkingLevel: (["minimal", "low", "medium", "high"].includes(thinkingLevel) ? thinkingLevel : null) as
      Settings["llmThinkingLevel"],
    llmTemperature: num(env, "LLM_TEMPERATURE", 0.3, 0, 2),
    llmTimeoutS: num(env, "LLM_TIMEOUT_S", 45, 1),

    embeddingProvider,
    embeddingModel,
    embeddingDim: num(env, "EMBEDDING_DIM", 768, 8, 3072),
    ragTopK: num(env, "RAG_TOP_K", 4, 1, 20),
    ragMinScore: num(env, "RAG_MIN_SCORE", MIN_SCORE[embeddingModel.toLowerCase()] ?? 0.35, 0, 1),

    agentEnabled: bool(env, "AGENT_ENABLED", true),
    agentFallback: bool(env, "AGENT_FALLBACK", true),
    agentMaxSteps: num(env, "AGENT_MAX_STEPS", 4, 1, 10),
    agentMaxToolCalls: num(env, "AGENT_MAX_TOOL_CALLS", 6, 1, 20),
    agentToolTimeoutS: num(env, "AGENT_TOOL_TIMEOUT_S", 15, 1),
    agentTimeoutS: num(env, "AGENT_TIMEOUT_S", 50, 1),

    mcpEnabled: bool(env, "MCP_HTTP_ENABLED", true),
    mcpAuthToken: str(env, "MCP_AUTH_TOKEN"),
    mcpRateLimitPerMinute: num(env, "MCP_RATE_LIMIT_PER_MINUTE", 60, 1),
    mcpRateLimitPerDay: num(env, "MCP_RATE_LIMIT_PER_DAY", 2000, 1),

    telemetryEnabled: bool(env, "TELEMETRY_ENABLED", true),
    telemetryStoreQuestions: bool(env, "TELEMETRY_STORE_QUESTIONS", false),
    runRetentionDays: num(env, "RUN_RETENTION_DAYS", 30, 1, 365),
    adminToken: str(env, "ADMIN_TOKEN"),
    readRateLimitPerMinute: num(env, "READ_RATE_LIMIT_PER_MINUTE", 60, 1),

    maxInputChars: num(env, "MAX_INPUT_CHARS", 800, 1),
    maxHistoryTurns: num(env, "MAX_HISTORY_TURNS", 6, 0),
    rateLimitPerMinute: num(env, "RATE_LIMIT_PER_MINUTE", 8, 1),
    rateLimitPerDay: num(env, "RATE_LIMIT_PER_DAY", 60, 1),
    dailyGlobalRequestBudget: num(env, "DAILY_GLOBAL_REQUEST_BUDGET", 1500, 1),
    // Vercel's edge sets X-Forwarded-For itself (client-supplied values are overwritten), so trusting it is safe there.
    trustProxyHeaders: bool(env, "TRUST_PROXY_HEADERS", onVercel),

    corsOrigins: str(env, "CORS_ORIGINS").split(",").map((o) => o.trim().replace(/\/$/, ""))
      .filter((o) => o && o !== "*"),
    environment: oneOf(env, "ENVIRONMENT", ["dev", "prod"] as const, onVercel ? "prod" : "dev"),
  };
}
