/**
 * Input guardrails. Heuristics only: the real defence is architectural.
 *   - the model has NO tools that mutate anything or read secrets,
 *   - the system prompt is never echoed back,
 *   - the API key lives only in server env,
 *   - output is length-capped and rendered as text (not HTML) by the frontend.
 *
 * The regexes are a cheap first filter for the obvious attacks, NOT the security boundary. They target the INTENT to
 * override or extract, rather than any mention of a word, otherwise honest questions ("does he manage secrets in
 * Docker?") would be refused.
 */
import type { Settings } from "./config.js";

const VERB = "(?:reveal|show|print|display|dump|leak|expose|output|repeat|recite|send|give|tell|share|read|cat|echo|" +
  "what(?:'s| is| are))";

const INJECTION: string[] = [
  // override: "ignore / forget / disregard (all) previous instructions" (+ common synonyms)
  String.raw`\b(?:ignore|disregard|forget|override|bypass|skip|drop)\b.{0,25}\b(?:previous|prior|above|earlier|preceding|all|your|these|the|any)\b.{0,20}\b(?:instructions?|prompts?|rules?|guidelines?|directives?|constraints?)\b`,
  String.raw`\bnew (?:instructions?|rules?)\s*:`,
  // prompt extraction
  String.raw`\b${VERB}\b.{0,30}\b(?:system|hidden|initial|original|secret|developer)\s+(?:prompt|instructions?|message)\b`,
  String.raw`\b${VERB}\b.{0,40}\byour\s+(?:prompt|instructions|rules|guidelines)\b`,
  String.raw`\bwhat (?:were|are) you (?:told|instructed|programmed)\b`,
  String.raw`\brepeat (?:everything|all|the text|the words) (?:above|before)\b`,
  // role / mode switching
  String.raw`\byou are now (?!viraj)`,
  String.raw`\bact as (?:an? )?(?:unrestricted|unfiltered|jailbroken|evil|dan)\b`,
  String.raw`\bpretend (?:you|to) (?:are|be|have) (?:no|without) (?:rules|restrictions|filters|limits)\b`,
  String.raw`\bdan\b|developer mode|jailbreak|do anything now|\bgod mode\b`,
  // secrets: asking for the VALUE of a key/secret/credential, or for the server's configuration
  String.raw`\bwhat(?:'s| is| are)\s+(?:the|your|his|its|this)\s+(?:\w+\s+)?(?:api[_ -]?keys?|secrets?|passwords?|tokens?|credentials?)\b`,
  String.raw`\b${VERB}\b.{0,30}\b(?:your|the (?:server|backend|site|app|bot|system)'?s?|this (?:site|app|bot))\b.{0,15}\b(?:api[_ -]?keys?|secrets?|passwords?|credentials?|tokens?|env(?:ironment)?[ _]?var(?:iable)?s?|\.env|config(?:uration)?)\b`,
  String.raw`\b(?:your|the backend'?s?|the server'?s?)\s+(?:api[_ -]?keys?|secrets?|passwords?|credentials?)\b`,
  String.raw`\bcat\s+\.env\b|\bprintenv\b|\bprocess\.env\b|\bos\.environ\b`,
  // the same override in other languages the site's visitors are likely to use
  String.raw`ignor(?:a|e|ez|iere|ar)\b.{0,25}(?:instrucciones|instructions|anweisungen|instru[cç][oõ]es|istruzioni)`,
  String.raw`(?:vergiss|oublie[sz]?|olvida|esquece)\b.{0,25}(?:anweisungen|instructions|instrucciones|instru[cç][oõ]es)`,
  String.raw`(?:पिछले|पिछली|सभी|ऊपर).{0,20}(?:निर्देश|आदेश).{0,15}(?:अनदेखा|भूल|ignore)`,
  String.raw`(?:मागील|वरील|सर्व).{0,20}(?:सूचना|आदेश).{0,15}(?:दुर्लक्ष|विसर)`,
];
const INJECTION_RE = INJECTION.map((p) => new RegExp(p, "is"));

// Lookalike letters people use to dodge keyword filters (Cyrillic/Greek that render like Latin, and leetspeak digits).
const CONFUSABLES: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", ѕ: "s", ԁ: "d",
  ο: "o", α: "a", ε: "e", ι: "i", ν: "v", ρ: "p", τ: "t", υ: "u",
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };
const SPACED_LETTERS = /\b(?:\w[\s.\-_*]){5,}\w\b/g; // "i g n o r e"  /  "i.g.n.o.r.e"

const mapChars = (text: string, table: Record<string, string>): string =>
  Array.from(text, (c) => table[c] ?? c).join("");

/** A copy of the text with common obfuscation undone. Used ONLY to run the patterns: the model still receives
 * exactly what the visitor wrote. */
export function normalizeForMatching(text: string): string {
  let t = mapChars(text.toLowerCase(), CONFUSABLES);
  t = t.replace(SPACED_LETTERS, (m) => m.replace(/[\s.\-_*]/g, ""));
  return mapChars(t, LEET);
}

function matches(text: string): boolean {
  const candidates = [text, normalizeForMatching(text)];
  return INJECTION_RE.some((r) => candidates.some((c) => r.test(c)));
}

export const REFUSAL = "I can only answer questions about Viraj's work, skills and projects.";

export class GuardrailViolation extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function sanitize(text: string): string {
  // strip control / zero-width characters often used to smuggle instructions (keep newline and tab)
  return text.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : "")).trim();
}

export function looksLikeInjection(text: string): boolean {
  return matches(sanitize(text));
}

export function checkInput(text: string, settings: Pick<Settings, "maxInputChars">): string {
  const clean = sanitize(text);
  if (!clean) throw new GuardrailViolation("Message is empty.");
  if ([...clean].length > settings.maxInputChars) {
    throw new GuardrailViolation(`Message too long (max ${settings.maxInputChars} characters).`, 413);
  }
  if (matches(clean)) throw new GuardrailViolation(REFUSAL);
  return clean;
}
