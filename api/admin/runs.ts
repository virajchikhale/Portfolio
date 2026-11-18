import { getState, getTelemetry } from "../../lib/app.js";
import { baseHeaders, bearerOk, errorResponse, json, unavailable } from "../../lib/http.js";
import { getKv } from "../../lib/kv.js";
import { clientIp, HttpError, readLimiter } from "../../lib/ratelimit.js";

/** Recent run summaries. Exists only when ADMIN_TOKEN is set; requires "Authorization: Bearer <token>". */
export async function GET(request: Request): Promise<Response> {
  let state;
  try {
    state = await getState();
  } catch (err) {
    return unavailable(err, baseHeaders(request, { corsOrigins: [] }));
  }
  const s = state.settings;
  const headers = baseHeaders(request, s);
  if (!s.adminToken) return json({ detail: "Not Found" }, 404, headers);
  try {
    await readLimiter(getKv(), s).check(clientIp(request, s));
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err, headers);
    throw err;
  }
  if (!bearerOk(request, s.adminToken)) {
    return json({ detail: "unauthorized" }, 401, { ...headers, "WWW-Authenticate": "Bearer" });
  }
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50) || 50;
  const telemetry = getTelemetry(state);
  return json({ runs: telemetry ? await telemetry.recent(limit) : [] }, 200, headers);
}
