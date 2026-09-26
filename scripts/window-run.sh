#!/usr/bin/env bash
# One-shot plan for the moment the free model route's window opens.
#
# The route rate-limits per window and probing re-arms the wait, so this script
# probes exactly once, then spends the window in order of value:
#   1. the demo recording        (the artifact a person actually watches)
#   2. hostile text + benchmark  (the hard, adversarial cases)
#   3. the real-page suite       (10 real pages x 3 questions, chunked if it throttles)
#   4. the full verification battery (ext-smoke, react-survival, everything)
#   5. the judge loops           (Muse grades the live evidence)
#
# Every step logs to spikes/out/window/. Safe to re-run: it never deletes anything,
# and if the route is closed it says so and exits 2 without touching the model.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=spikes/out/window
mkdir -p "$LOG"
step() { echo; echo "=== $* ==="; }

step "1/5 probe the route (one search, nothing else)"
probe=$(curl -sf -m 45 -X POST http://127.0.0.1:4199/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"security deposit","passages":[{"id":"p0","text":"A security deposit of Rs. 250 is charged and refunded within 30 days."}]}' || true)
printf '%s' "$probe" | head -c 600 > "$LOG/probe.json"
if ! grep -q '"results"' "$LOG/probe.json"; then
  echo "route still closed — not spending anything else."
  head -c 300 "$LOG/probe.json"; echo
  exit 2
fi
echo "route open."

step "2/5 demo recording"
timeout 400 xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/demo-record.py 2>&1 | tee "$LOG/demo.log" | tail -6

step "3/5 hostile text + benchmark"
timeout 400 node scripts/hostile-text.mjs 2>&1 | tee "$LOG/hostile.log" | tail -4
timeout 400 node scripts/benchmark.mjs 2>&1 | tee "$LOG/bench.log" | tail -6

step "4/5 real pages (10 x 3)"
timeout 900 python3 scripts/realpage-suite.py --run 2>&1 | tee "$LOG/realpages.log" | tail -8

step "5/5 full verification battery"
timeout 1200 ./scripts/verify-all.sh 2>&1 | tee "$LOG/battery.log" | tail -18

echo
echo "window plan finished. logs in $LOG/"
