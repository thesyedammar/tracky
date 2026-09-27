#!/usr/bin/env bash
# Tracky helper — run ./start-tracky.sh instead of typing the node command.
# Needs Node 22+ (node --version to check).
cd "$(dirname "$0")"
echo "Starting the Tracky helper... leave this window open while you browse."
exec node server/server.mjs
