/**
 * Precompute the document embeddings into content/embeddings.json (commit the result).
 *
 *   npm run embed            # needs GEMINI_API_KEY; only chunks that are new or changed are sent to the API
 *
 * Re-run it after editing anything in content/data, or after changing EMBEDDING_MODEL / EMBEDDING_DIM.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadSettings } from "../lib/config.js";
import { chunkEmbedText, loadChunks } from "../lib/content.js";
import { chunkKey, embeddingsFile, GeminiEmbedder, loadEmbeddingCache } from "../lib/rag.js";

const s = loadSettings();
const chunks = loadChunks();
const cache = loadEmbeddingCache();
const keys = chunks.map((c) => chunkKey(c, s.embeddingModel, s.embeddingDim));
const missing = keys.flatMap((k, i) => (cache[k] ? [] : [i]));

const vectors: Record<string, number[]> = {};
keys.forEach((k) => { if (cache[k]) vectors[k] = cache[k]!; });
if (missing.length) {
  console.log(`embedding ${missing.length} new/changed chunk(s) of ${chunks.length} with ${s.embeddingModel} (${s.embeddingDim} dims)…`);
  const fresh = await new GeminiEmbedder(s).embedDocuments(missing.map((i) => chunkEmbedText(chunks[i]!)));
  missing.forEach((i, j) => { vectors[keys[i]!] = fresh[j]!.map((x) => Math.round(x * 1e5) / 1e5); });
} else {
  console.log(`all ${chunks.length} chunk(s) already embedded.`);
}

const file = embeddingsFile();
const out = JSON.stringify({ model: s.embeddingModel, dim: s.embeddingDim, vectors });
let before = "";
try { before = readFileSync(file, "utf8"); } catch { /* first run */ }
if (before !== out) writeFileSync(file, out + "\n");
console.log(`${before === out ? "unchanged" : "wrote"} ${file} (${Object.keys(vectors).length} vectors, ${(out.length / 1024).toFixed(0)} KB)`);
