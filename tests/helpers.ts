import type { Payload } from "../lib/agent.js";

/** Parse a text/event-stream body into its JSON payloads (and whether [DONE] arrived). */
export function parseSse(body: string): { items: Payload[]; done: boolean } {
  const items: Payload[] = [];
  let done = false;
  for (const block of body.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") done = true;
    else items.push(JSON.parse(data));
  }
  return { items, done };
}

export const text = (items: Payload[]) => items.filter((i) => "delta" in i).map((i) => i.delta).join("");

export function chatRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body) });
}
