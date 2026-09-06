#!/bin/sh
# The agent's turn, as the skill prescribes: read the open Annotations, publish the next Version,
# mark the one it answered as addressed. (Addressed first here only so the Reader's reload sees it.)
set -e
. demo/walkthrough/fixtures/ids.env
T=$(cat demo/walkthrough/fixtures/token); U=http://localhost:8827
AID=$(curl -fsS -H "Authorization: Bearer $T" "$U/api/artifacts/$DOC/annotations?status=open" \
  | node -p 'JSON.parse(require("fs").readFileSync(0)).find(a=>a.text.includes("留白")).annotation')
curl -fsS -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -X PATCH "$U/api/annotations/$AID" -d '{"status":"addressed"}' >/dev/null
curl -fsS -H "Authorization: Bearer $T" -H 'Content-Type: text/markdown' --data-binary @demo/walkthrough/fixtures/v2.md \
  -X POST "$U/api/artifacts/$DOC/versions?canvas=720" >/dev/null
