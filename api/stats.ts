import { getState, getTelemetry } from "../lib/app.js";
import { baseHeaders, errorResponse, json, unavailable } from "../lib/http.js";
import { getKv } from "../lib/kv.js";
import { clientIp, HttpError, readLimiter } from "../lib/ratelimit.js";

/** Read-only statistics: aggregates only (no questions, no answers, nothing per visitor). */
export async function GET(request: Request): Promise<Response> {
  let state;
  try {
    state = await getState();
  } catch (err) {
    return unavailable(err, baseHeaders(request, { corsOrigins: [] }));
  }
  const headers = baseHeaders(request, state.settings);
  try {
    await readLimiter(getKv(), state.settings).check(clientIp(request, state.settings));
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err, headers);
    throw err;
  }
  const telemetry = getTelemetry(state);
  if (!telemetry) return json({ enabled: false }, 200, headers);
  const window = new URL(request.url).searchParams.get("window") ?? "24h";
  return json({ enabled: true, ...(await telemetry.stats(window)) }, 200, headers);
}
