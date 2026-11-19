import { getState } from "../lib/app.js";
import { baseHeaders, json, unavailable } from "../lib/http.js";

export async function GET(request: Request): Promise<Response> {
  let state;
  try {
    state = await getState();
  } catch (err) {
    return unavailable(err, baseHeaders(request, { corsOrigins: [] }));
  }
  // deliberately reveals no secrets / config values
  return json({
    status: "ok",
    skills: Object.keys(state.skills).sort(),
    provider: state.settings.llmProvider,
    rag: { enabled: state.rag !== null, chunks: state.chunks.length, reason: state.ragReason },
  }, 200, baseHeaders(request, state.settings));
}
