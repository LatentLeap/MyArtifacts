#!/bin/sh
# The walkthrough's own MyArtifacts: fresh data from the fixture on every run, ports 8827/8828.
# Run from the repo root (ndemo setup steps run there).
set -e
D=demo/walkthrough/.data
for p in $(lsof -ti tcp:8827 -sTCP:LISTEN 2>/dev/null); do kill "$p"; done
for i in $(seq 1 50); do lsof -ti tcp:8827 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.1; done
rm -rf "$D" && mkdir -p "$D"
tar xzf demo/walkthrough/fixtures/data.tgz -C "$D"
MYARTIFACTS_DATA="$D" MYARTIFACTS_PORT=8827 MYARTIFACTS_USERCONTENT_PORT=8828 \
  nohup node src/server.ts > "$D/server.log" 2>&1 &
for i in $(seq 1 50); do curl -fsS -o /dev/null http://localhost:8827/login 2>/dev/null && exit 0; sleep 0.1; done
echo "server did not come up" >&2; cat "$D/server.log" >&2; exit 1
