#!/bin/bash
# From the laptop, no SSH (Clash TUN breaks it): tar the tree, park it on OSS for an hour,
# have Cloud Assistant pull it to /opt/myartifacts and run deploy/setup.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
# deploy/deploy.local.env (gitignored): INSTANCE=<swas instance id>  BUCKET=oss://<bucket>
. deploy/deploy.local.env
: "${INSTANCE:?}" "${BUCKET:?}"
tar -czf /tmp/myartifacts.tgz --exclude node_modules --exclude .git --exclude data --exclude .scratch --exclude demo --exclude .claude .
aliyun oss cp /tmp/myartifacts.tgz "$BUCKET/deploy/myartifacts.tgz" --force --region ap-northeast-1 --endpoint oss-ap-northeast-1.aliyuncs.com >/dev/null
URL=$(aliyun oss sign "$BUCKET/deploy/myartifacts.tgz" --timeout 3600 --region ap-northeast-1 --endpoint oss-ap-northeast-1.aliyuncs.com | head -1)
SCRIPT="set -e; mkdir -p /opt/myartifacts; curl -fsSL '$URL' | tar -xz -C /opt/myartifacts; bash /opt/myartifacts/deploy/setup.sh"
ID=$(aliyun swas-open run-command --region cn-hongkong --biz-region-id cn-hongkong --instance-id $INSTANCE --name deploy --type RunShellScript --timeout 600 --command-content "$SCRIPT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["InvokeId"])')
for _ in $(seq 60); do
	sleep 5
	R=$(aliyun swas-open describe-invocation-result --region cn-hongkong --biz-region-id cn-hongkong --instance-id $INSTANCE --invoke-id "$ID")
	S=$(printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["InvocationResult"]["InvocationStatus"])')
	[ "$S" = Running ] || [ "$S" = Pending ] || break
done
printf '%s' "$R" | python3 -c 'import sys,json,base64;r=json.load(sys.stdin)["InvocationResult"];print(r["InvocationStatus"],r.get("ExitCode"));print(base64.b64decode(r.get("Output","")).decode(errors="replace"))'
