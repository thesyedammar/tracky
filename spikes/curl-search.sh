#!/usr/bin/env bash
# Tracky helper demo — health, preview (no Jev call), search. All via curl.
#
# Usage:  bash spikes/curl-search.sh ["your query"]
# Needs:  the helper running (node server/server.mjs) + curl + node.
set -euo pipefail

BASE="${TRACKY_BASE:-http://127.0.0.1:4199}"
QUERY="${1:-hidden charges}"
FIXTURE="${2:-spikes/fixtures/tos.txt}"

PAYLOAD=$(node -e '
  const fs = require("node:fs");
  const text = fs.readFileSync(process.argv[2], "utf8");
  const passages = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).map((s, i) => ({ id: "p" + i, text: s }));
  process.stdout.write(JSON.stringify({ query: process.argv[1], passages }));
' "$QUERY" "$FIXTURE")

echo "— health —"
curl -s "$BASE/api/health"; echo
echo
echo "— preview (first 500 chars of the exact Jev payload; nothing is sent) —"
curl -s -X POST "$BASE/api/preview" -H 'content-type: application/json' --data "$PAYLOAD" | head -c 500; echo
echo
echo "— search “$QUERY” —"
curl -s -X POST "$BASE/api/search" -H 'content-type: application/json' --data "$PAYLOAD"; echo
echo
echo "— stream (progress frames) —"
curl -sN -X POST "$BASE/api/search?stream=1" -H 'content-type: application/json' --data "$PAYLOAD" | grep -E '^event:|^data:' | head -12
