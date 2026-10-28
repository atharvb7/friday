#!/usr/bin/env bash
# Open a PR from <branch> into develop, wait for CI, merge it, delete the branch.
# Uses the GITHUB_TOKEN that lives on the server (~/friday/.env), so the token never touches your laptop or chat.
# Usage: scripts/pr-merge.sh user@host <branch> "<title>" ["<body>"]
set -euo pipefail
HOST="${1:?host}"; BRANCH="${2:?branch}"; TITLE="${3:?title}"; BODY="${4:-}"
git push -q origin "$BRANCH"
ssh -o BatchMode=yes "$HOST" "bash -s -- $(printf '%q ' "$BRANCH" "$TITLE" "$BODY")" <<'REMOTE'
set -e; BR="$1"; TITLE="$2"; BODY="$3"
cd ~/friday; TOK=$(grep "^GITHUB_TOKEN=" .env | tail -1 | cut -d= -f2-)
api() { curl -s -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" "$@"; }
R=https://api.github.com/repos/atharvb7/friday
PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'title':sys.argv[1],'head':sys.argv[2],'base':'develop','body':sys.argv[3]}))" "$TITLE" "$BR" "$BODY")
PR=$(api "$R/pulls?state=open&head=atharvb7:$BR" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['number'] if d else '')")
if [ -z "$PR" ]; then PR=$(api -X POST $R/pulls -d "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('number') or d)"); echo "PR #$PR opened"; else echo "reusing open PR #$PR"; fi; sleep 8
SHA=$(api $R/pulls/$PR | python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])")
for i in $(seq 1 60); do
  # Every check run must be finished and green, not just the first one.
  S=$(api "$R/commits/$SHA/check-runs" | python3 -c "import sys,json; c=json.load(sys.stdin).get('check_runs',[]); print('none' if not c else 'running' if any(x['status']!='completed' for x in c) else 'completed success' if all(x['conclusion'] in ('success','skipped','neutral') for x in c) else 'completed failure')")
  echo "ci: $S"; case "$S" in completed*) break;; esac; sleep 10
done
if [ "$S" = "completed success" ]; then
  M=$(api -X PUT $R/pulls/$PR/merge -d '{"merge_method":"merge"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('merged:', d.get('merged'), d.get('message'))"); echo "$M"
  case "$M" in "merged: True"*) ;; *) echo "merge refused: PR #$PR and its branch left as they are"; exit 1;; esac # never delete the branch of an unmerged PR
  api -X DELETE $R/git/refs/heads/$BR -o /dev/null -w "branch deleted: http %{http_code}\n"
else echo "CI not green: PR #$PR left open"; exit 1; fi
REMOTE
