import { describe, expect, it } from "vitest";
import retrievalSet from "./retrieval_set.json" with { type: "json" };
import { chunkMarkdown, loadChunks, loadSkills } from "../lib/content.js";
import { buildRag, chunkKey, GeminiEmbedder, LexicalIndex, RagError, type Embedder } from "../lib/rag.js";
import { loadSettings } from "../lib/config.js";

const chunks = loadChunks();
const settings = loadSettings({ EMBEDDING_PROVIDER: "none", LLM_PROVIDER: "fake" });

describe("content", () => {
  it("loads the corpus without core.md and every skill", () => {
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.some((c) => c.source === "core.md")).toBe(false);
    expect(Object.keys(loadSkills()).sort()).toEqual(["about-viraj", "contact-handoff", "project-explainer"]);
  });
  it("splits on ## headings and long sections on paragraphs", () => {
    const out = chunkMarkdown("a.md", "# Title\n\nintro\n\n## One\nfoo\n\n## Two\n" + "para\n\n".repeat(400));
    expect(out[0]).toMatchObject({ title: "Title", heading: "Title", content: "intro" });
    expect(out.filter((c) => c.heading === "Two").length).toBeGreaterThan(1);
    expect(out.every((c) => c.content.length <= 1300)).toBe(true);
  });
});

describe("keyword-only retrieval (no embedding key)", () => {
  it("finds rare proper nouns and ignores off-topic questions", async () => {
    const rag = await buildRag(chunks, settings);
    expect(rag.denseReady).toBe(false);
    const hit = await rag.retrieve("What did he do at Inorbvict?", settings);
    expect(hit.map((h) => h.chunk.source)).toContain("experience.md");
    expect(await rag.retrieve("What's the weather in Paris today?", settings)).toEqual([]);
  });

  it("covers the shared retrieval eval set: no off-topic leakage, and most in-scope questions found", async () => {
    const rag = await buildRag(chunks, settings);
    let found = 0, inScope = 0, leaked: string[] = [];
    for (const item of retrievalSet as { q: string; expect: string[] }[]) {
      const hits = await rag.retrieve(item.q, settings);
      if (item.expect.length) {
        inScope++;
        if (hits.some((h) => item.expect.includes(h.chunk.source))) found++;
      } else if (hits.length) leaked.push(item.q);
    }
    console.log(`keyword-only recall: ${found}/${inScope}; leaked: ${leaked.length}`);
    expect(leaked).toEqual([]);
    expect(found / inScope).toBeGreaterThanOrEqual(0.5);
  });
});

describe("hybrid retrieval with a stub embedder", () => {
  // Cosine against a one-hot "topic" vector: lets us test the gate and the fusion deterministically.
  const dim = chunks.length;
  const vec = (i: number) => Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
  const stub: Embedder = {
    embedDocuments: async (texts) => texts.map((_, i) => vec(i)),
    embedQuery: async (q) => (q.includes("EDU") ? vec(chunks.findIndex((c) => c.source === "education.md")) : Array(dim).fill(0)),
  };
  it("dense hits pass the gate; a zero-similarity query retrieves nothing; reason is null", async () => {
    const s = loadSettings({ EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: "x", LLM_PROVIDER: "fake" });
    const rag = await buildRag(chunks, s, stub, {});
    expect(rag.denseReady).toBe(true);
    const hits = await rag.retrieve("EDU please", s);
    expect(hits[0]).toMatchObject({ via: "dense" });
    expect(hits[0]!.chunk.source).toBe("education.md");
    expect(await rag.retrieve("nothing relevant", s)).toEqual([]);
  });
  it("degrades to keyword search (with a reason) when embedding fails", async () => {
    const s = loadSettings({ EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: "x", LLM_PROVIDER: "fake" });
    const broken: Embedder = { embedDocuments: async () => { throw new RagError("boom", "embedding_failed"); }, embedQuery: async () => [] };
    const rag = await buildRag(chunks, s, broken, {});
    expect(rag.denseReady).toBe(false);
    expect(rag.reason).toBe("embedding_failed");
    expect((await rag.retrieve("What did he do at Inorbvict?", s)).map((h) => h.chunk.source)).toContain("experience.md");
  });
});

describe("precomputed embeddings cache", () => {
  const s = loadSettings({ EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: "x", LLM_PROVIDER: "fake" });
  const dim = chunks.length;
  const vec = (i: number) => Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));

  it("embeds nothing when every chunk is cached, and only the missing ones otherwise", async () => {
    const cache = Object.fromEntries(chunks.map((c, i) => [chunkKey(c, s.embeddingModel, s.embeddingDim), vec(i)]));
    const calls: number[] = [];
    const stub: Embedder = { embedDocuments: async (t) => { calls.push(t.length); return t.map(() => vec(0)); }, embedQuery: async () => vec(0) };
    expect((await buildRag(chunks, s, stub, cache)).denseReady).toBe(true);
    expect(calls).toEqual([]); // zero embedding calls at cold start

    delete cache[chunkKey(chunks[3]!, s.embeddingModel, s.embeddingDim)];
    await buildRag(chunks, s, stub, cache);
    expect(calls).toEqual([1]);
  });
  it("a changed model or dimension invalidates every key", () => {
    expect(chunkKey(chunks[0]!, "m1", 768)).not.toBe(chunkKey(chunks[0]!, "m2", 768));
    expect(chunkKey(chunks[0]!, "m1", 768)).not.toBe(chunkKey(chunks[0]!, "m1", 256));
  });
});

describe("Gemini embedder", () => {
  it("requires a key", () => expect(() => new GeminiEmbedder({ geminiApiKey: "", embeddingModel: "m", embeddingDim: 8 })).toThrow(RagError));
});

describe("LexicalIndex", () => {
  it("requires coverage of the question's content words", () => {
    const idx = new LexicalIndex(chunks);
    expect(idx.search("weather Paris pizza", 3)).toEqual([]);
  });
});
