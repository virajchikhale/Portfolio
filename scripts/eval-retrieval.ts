/**
 * Measure retrieval quality for the CONFIGURED embedding model and recommend RAG_MIN_SCORE.
 *
 *   npm run eval:retrieval            (reads GEMINI_API_KEY / EMBEDDING_* from the environment)
 *
 * Runs the real hybrid retriever over content/data against tests/retrieval_set.json:
 *   - in-scope questions must surface an expected source (recall / MRR),
 *   - off-topic questions ("expect": []) must retrieve NOTHING (leakage),
 *   - "kind": "entity" questions name rare proper nouns that small dense models miss: they show the keyword channel's
 *     contribution and are excluded from the dense-threshold recommendation.
 */
import { readFileSync } from "node:fs";
import { loadSettings } from "../lib/config.js";
import { loadChunks } from "../lib/content.js";
import { buildRag } from "../lib/rag.js";

const s = loadSettings();
const rag = await buildRag(loadChunks(), s);
const set = JSON.parse(readFileSync(new URL("../tests/retrieval_set.json", import.meta.url), "utf8")) as
  { q: string; expect: string[]; kind?: string }[];

console.log(`dense=${rag.denseReady}${rag.reason ? ` (${rag.reason})` : ""} model=${s.embeddingModel} dim=${s.embeddingDim} ` +
  `top_k=${s.ragTopK} RAG_MIN_SCORE=${s.ragMinScore}\n`);

const inScope: { item: (typeof set)[number]; rank: number | null; denseRank: number | null; best: number; via: string; label: string }[] = [];
const off: { q: string; top: number; leaked: string[] }[] = [];
for (const item of set) {
  const hits = await rag.retrieve(item.q, s);
  const raw = await rag.denseScores(item.q, s.ragTopK);
  if (item.expect.length) {
    const rank = hits.findIndex((h) => item.expect.includes(h.chunk.source)) + 1 || null;
    const denseRank = raw.filter((r) => r.score >= s.ragMinScore).findIndex((r) => item.expect.includes(r.chunk.source)) + 1 || null;
    const best = raw.find((r) => item.expect.includes(r.chunk.source))?.score ?? 0;
    inScope.push({ item, rank, denseRank, best, via: hits[0]?.via ?? "-", label: hits[0] ? `${hits[0].chunk.title} › ${hits[0].chunk.heading}` : "(nothing retrieved)" });
  } else {
    off.push({ q: item.q, top: raw[0]?.score ?? 0, leaked: hits.map((h) => h.chunk.heading) });
  }
}

console.log("IN-SCOPE (want an expected source in the final results)");
for (const r of inScope) {
  console.log(`  ${r.rank ? "✓" : "✗"} rank=${r.rank ?? "-"} via=${r.via.padEnd(7)}${r.item.kind === "entity" ? " [entity]" : ""} ${r.item.q}  -> ${r.label}`);
}
console.log("\nOFF-TOPIC (want nothing retrieved)");
for (const r of off) console.log(`  ${r.leaked.length ? "✗ LEAK" : "✓"}  dense_top=${r.top.toFixed(3)}  ${r.q}  -> ${r.leaked.join(", ") || "nothing"}`);

const found = inScope.filter((r) => r.rank).length;
const mrr = inScope.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / Math.max(inScope.length, 1);
const leaked = off.filter((r) => r.leaked.length).length;
console.log(`\nHYBRID      recall@${s.ragTopK} = ${found}/${inScope.length}   MRR = ${mrr.toFixed(2)}   off-topic leakage = ${leaked}/${off.length}`);
if (rag.denseReady) {
  console.log(`DENSE ONLY  recall@${s.ragTopK} = ${inScope.filter((r) => r.denseRank).length}/${inScope.length}   (without the keyword channel)`);
  const best = inScope.filter((r) => r.item.kind !== "entity").map((r) => r.best);
  const lo = Math.max(0, ...off.map((r) => r.top)), hi = Math.min(...best);
  console.log(hi > lo
    ? `recommended RAG_MIN_SCORE = ${((lo + hi) / 2).toFixed(2)}  (midpoint of clean gap ${lo.toFixed(3)} .. ${hi.toFixed(3)}; current ${s.ragMinScore})`
    : `no clean dense threshold for this model (gap ${lo.toFixed(3)} .. ${hi.toFixed(3)} overlaps); current ${s.ragMinScore}`);
}
process.exit(leaked === 0 && found === inScope.length ? 0 : 1);
