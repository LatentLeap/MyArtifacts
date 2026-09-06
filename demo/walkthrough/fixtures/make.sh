#!/bin/sh
# Rebuilds data.tgz, token and ids.env from scratch through the public API, then rewrites the
# playbook's ids. Run from the repo root. Only needed when the fixture documents change.
set -e
F=demo/walkthrough/fixtures; D=demo/walkthrough/.data; U=http://localhost:8827; P=demo/walkthrough/walkthrough.yaml
PAGES=${PAGES:-.claude/worktrees/proto-three-shapes/prototype/three-shapes/pages}
for p in $(lsof -ti tcp:8827 -sTCP:LISTEN 2>/dev/null); do kill "$p"; done; sleep 0.5
[ -f $F/ids.env ] && . $F/ids.env; OLD_DOC=${DOC:-}; OLD_PR=${POLL_READER:-}; OLD_T=$(cat $F/token 2>/dev/null || true)
rm -rf $D && mkdir -p $D
T=$(MYARTIFACTS_DATA=$D node src/server.ts mint-token alice)
MYARTIFACTS_DATA=$D MYARTIFACTS_PORT=8827 MYARTIFACTS_USERCONTENT_PORT=8828 node src/server.ts > $D/server.log 2>&1 &
SRV=$!
for i in $(seq 1 50); do curl -fsS -o /dev/null $U/login 2>/dev/null && break; sleep 0.1; done
A="Authorization: Bearer $T"; id() { node -p 'JSON.parse(require("fs").readFileSync(0)).'$1; }
DOC=$(curl -fsS -H "$A" -H 'Content-Type: text/markdown' --data-binary @$F/v1.md -X POST "$U/api/artifacts?canvas=720" | id artifact)
POLL=$(curl -fsS -H "$A" -H 'Content-Type: text/html' --data-binary @$PAGES/poll.html -X POST "$U/api/artifacts?canvas=480" | id artifact)
PR=$(curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$U/api/artifacts/$POLL/readers" -d '{"name":"王工"}' | id url)
kill $SRV; wait $SRV 2>/dev/null || true
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$D/myartifacts.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
tar czf $F/data.tgz -C $D myartifacts.db versions
echo "$T" > $F/token
printf 'DOC=%s\nPOLL=%s\nPOLL_READER=%s\n' "$DOC" "$POLL" "$PR" > $F/ids.env
[ -n "$OLD_DOC" ] && sed -i '' "s|$OLD_DOC|$DOC|g; s|$OLD_PR|$PR|g; s|$OLD_T|$T|g" $P
echo "fixture rebuilt: DOC=$DOC POLL=$POLL"
