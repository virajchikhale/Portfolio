#!/usr/bin/env bash
# Runs every browser check page against the real app in headless Firefox. Needs: python deps of backend/ and Firefox.
#   e2e/run.sh                 # all pages
#   e2e/run.sh ui hard         # some pages
# Env: E2E_EMBEDDINGS=local|fake (default local; needs the model: set EMBEDDING_CACHE_DIR), E2E_PORT (default 8767),
#      PYTHON (default python3), FIREFOX (default firefox).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-python3}"; FF="${FIREFOX:-firefox}"; PORT="${E2E_PORT:-8767}"
OUT="$HERE/.out"; mkdir -p "$OUT"
PAGES=("$@"); [ ${#PAGES[@]} -eq 0 ] && PAGES=(pipeline dock agent ui hard)
# page:seconds the page is kept alive (slow-mode checks run in real time); hard also runs once with storage blocked
declare -A KEEP=([pipeline]=280 [dock]=60 [agent]=400 [ui]=280 [hard]=60)

"$PY" "$HERE/server.py" </dev/null >"$OUT/server.log" 2>&1 & SERVER=$!
trap 'kill $SERVER 2>/dev/null; pkill -x firefox 2>/dev/null; pkill -x firefox-bin 2>/dev/null; rm -rf "${TMPDIR:-/tmp}"/e2e-ffprof.*' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "server did not start:"; tail -20 "$OUT/server.log"; exit 2; }

fail=0
run_page() {  # name, query-string
  local name="$1" query="$2" keep="$3"
  rm -f "$OUT/report.json"; pkill -x firefox 2>/dev/null; pkill -x firefox-bin 2>/dev/null; sleep 1
  local prof; prof="$(mktemp -d "${TMPDIR:-/tmp}/e2e-ffprof.XXXX")"   # FRESH each time (a reused one gets corrupted by kills); outside the repo: Firefox failed to start with a profile under it
  timeout $((keep + 90)) "$FF" --headless --no-remote --profile "$prof" --window-size=1300,900 \
    "http://127.0.0.1:$PORT/t.html?page=${query}&d=${keep}&skipboot=1" </dev/null >/dev/null 2>&1 &
  for _ in $(seq 1 $((keep + 80))); do
    "$PY" - <<PYEOF 2>/dev/null && break
import json, sys
r = json.load(open("$OUT/report.json"))
sys.exit(0 if r and r[-1].startswith(("PASS no uncaught", "FAIL no uncaught")) else 1)
PYEOF
    sleep 1
  done
  "$PY" - <<PYEOF || fail=1
import json, sys
try:
    r = json.load(open("$OUT/report.json"))
except Exception as e:
    print(f"{'$name':9} NO REPORT ({e})"); sys.exit(1)
p = sum(l.startswith("PASS") for l in r); f = sum(l.startswith("FAIL") for l in r)
print(f"{'$name':9} {p} passed, {f} failed")
for l in r:
    if l.startswith("FAIL"): print("    ", l[:220])
sys.exit(1 if f or not p else 0)
PYEOF
}

for p in "${PAGES[@]}"; do
  run_page "$p" "$p" "${KEEP[$p]:-120}"
  [ "$p" = hard ] && run_page "hard (storage blocked)" "hard&nostorage=1" 60
done
echo; [ $fail -eq 0 ] && echo "e2e: all green" || echo "e2e: FAILURES"
exit $fail
