import { describe, expect, it } from "vitest";
import redteam from "./redteam.json" with { type: "json" };
import { checkInput, GuardrailViolation, normalizeForMatching, sanitize } from "../lib/guardrails.js";

const S = { maxInputChars: 2000 };
const refused = (t: string) => {
  try {
    checkInput(t, S);
    return false;
  } catch (e) {
    if (e instanceof GuardrailViolation) return true;
    throw e;
  }
};

describe("red-team suite (parity with the Python guardrails)", () => {
  it.each(redteam.block)("refuses: $c $t", ({ t }) => expect(refused(t), `not blocked: ${t}`).toBe(true));
  it.each(redteam.allow)("does not refuse: $t", ({ t }) => expect(refused(t), `false positive: ${t}`).toBe(false));
  it("documented gaps are really gaps (move to block if one starts being caught)", () => {
    expect(redteam.gap.some((c) => refused(c.t))).toBe(false);
  });
});

describe("normalisation", () => {
  it.each([["1gn0re", "ignore"], ["i g n o r e", "ignore"], ["i.g.n.o.r.e", "ignore"], ["ignоre", "ignore"],
    ["Pr3v10us", "previous"], ["syst3m", "system"]])("%s -> %s", (raw, expected) => {
    expect(normalizeForMatching(raw)).toContain(expected);
  });
});

describe("input checks", () => {
  it("accepts a normal question", () => expect(checkInput("What projects has Viraj built?", S)).toBe("What projects has Viraj built?"));
  it("rejects empty and too long (413)", () => {
    expect(() => checkInput("   ", S)).toThrow(GuardrailViolation);
    try {
      checkInput("x".repeat(801), { maxInputChars: 800 });
      expect.unreachable();
    } catch (e) {
      expect((e as GuardrailViolation).status).toBe(413);
    }
  });
  it("strips zero-width and control characters but keeps newlines", () => {
    expect(sanitize("he​llo\u0007\nworld")).toBe("hello\nworld");
  });
});
