#!/usr/bin/env bash
# Tracky — one command that re-checks everything (the "recheck everything" run).
#
# Runs every verification in the order that fails fastest, writes one log per step
# into spikes/out/verify/, and prints a summary table at the end. Model-dependent
# steps are marked, so a rate-limited window is visible instead of mysterious.
#
#   ./scripts/verify-all.sh              # everything
#   ./scripts/verify-all.sh --no-model   # skip steps that need the model route
#
# Exit: 0 only when every step that ran passed.

set -uo pipefail
cd "$(dirname "$0")/.."

OUT=spikes/out/verify
mkdir -p "$OUT"
NO_MODEL=0
[[ "${1:-}" == "--no-model" ]] && NO_MODEL=1

declare -a NAMES=() RESULTS=() DETAILS=()
run() { # run <name> <needs-model 0|1> <command...>
  local name="$1" needs="$2"; shift 2
  if [[ $needs == 1 && $NO_MODEL == 1 ]]; then
    NAMES+=("$name"); RESULTS+=("SKIP"); DETAILS+=("needs the model route")
    printf '  ○ %-34s skipped (needs the model route)\n' "$name"
    return 0
  fi
  local log="$OUT/$(echo "$name" | tr ' /' '__').log"
  local t0; t0=$(date +%s)
  "$@" >"$log" 2>&1
  local rc=$?
  local t1; t1=$(date +%s)
  if [[ $rc -eq 0 ]]; then
    local line; line=$(grep -Eo '([0-9]+/[0-9]+ (checks|checks passed|cases)|# pass [0-9]+|ALL GOOD|ALL CHECKS PASSED|ALL CASES PASSED|0 leaks|passed)' "$log" | tail -1)
    NAMES+=("$name"); RESULTS+=("PASS"); DETAILS+=("$((t1-t0))s${line:+ · $line}")
    printf '  ✓ %-34s pass  (%ss%s)\n' "$name" "$((t1-t0))" "${line:+ · $line}"
  elif [[ $rc -eq 2 ]]; then
    local n; n=$(grep -c 'blocked by the model route' "$log")
    NAMES+=("$name"); RESULTS+=("BLOCKED"); DETAILS+=("$((t1-t0))s · model route rate-limited")
    printf '  ◐ %-34s BLOCKED  (model route rate-limited — re-run when the window opens)\n' "$name"
  else
    local why; why=$(grep -Ei 'FAIL|Error|refused|violation' "$log" | head -1 | cut -c1-90)
    NAMES+=("$name"); RESULTS+=("FAIL"); DETAILS+=("$((t1-t0))s · $why")
    printf '  ✗ %-34s FAIL  (%ss · %s)\n' "$name" "$((t1-t0))" "$why"
    printf '      log: %s\n' "$log"
  fi
}

echo "Tracky — full verification run ($(TZ=Asia/Kolkata date '+%d %b %Y %H:%M IST'))"
echo

run "unit tests"            0 node --test server/test/*.test.mjs extension/direct.test.mjs
run "key-leak audit"        0 node scripts/key-leak-check.mjs
run "packaging"             0 node scripts/package-extension.mjs
run "helper health"         0 bash -c 'curl -sf http://127.0.0.1:4199/api/health | head -c 200'
run "pdf mode (34 checks)"  0 xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/pdf-smoke.py
run "extension smoke (fixture)" 0 xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/ext-smoke.py
run "extension smoke (wikipedia)" 0 env TRACKY_SMOKE_URL="https://en.wikipedia.org/wiki/Lease" TRACKY_SMOKE_QUERY="security deposit" xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/ext-smoke.py
run "source picker"          0 xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/source-picker-smoke.py
run "direct mode (39 checks)" 0 xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/direct-smoke.py
run "react survival"        0 xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/react-survival.py
run "hostile text"          1 node scripts/hostile-text.mjs
run "benchmark suite"       1 node scripts/benchmark.mjs
run "real pages (10 x 3)"   1 python3 scripts/realpage-suite.py --run

echo
fails=0; skips=0; blocked=0
for i in "${!NAMES[@]}"; do
  case "${RESULTS[$i]}" in
    FAIL) fails=$((fails+1)) ;;
    SKIP) skips=$((skips+1)) ;;
    BLOCKED) blocked=$((blocked+1)) ;;
  esac
done
total=${#NAMES[@]}
printf 'summary: %d passed · %d failed · %d blocked by the model route · %d skipped (of %d)\n' \
  "$((total-fails-skips-blocked))" "$fails" "$blocked" "$skips" "$total"
if [[ $fails -gt 0 ]]; then echo "real failures present — see the logs above."; exit 1; fi
if [[ $blocked -gt 0 ]]; then echo "no real failures; re-run when the model window is open."; exit 2; fi
echo "every step that ran passed."
exit 0
