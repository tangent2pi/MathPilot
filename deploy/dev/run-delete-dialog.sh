#!/usr/bin/env bash
# 单条 Bash 内完整验证：启动 Chrome(9445) → CDP 走查删除确认 Dialog → 收尾
set -u
export PATH="$PATH:/c/Users/小渊/AppData/Roaming/npm:/c/Program Files/nodejs"
CHROME="/c/Users/小渊/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe"
NODE="/c/Users/小渊/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
cd /d/git/mathpilot/MathPilot_next/deploy/dev || exit 1

taskkill //F //IM chrome.exe >/dev/null 2>&1
sleep 2
rm -rf /c/Users/小渊/.agent-browser/cdp-k3

"$CHROME" --headless=new --remote-debugging-port=9445 --no-first-run --no-default-browser-check \
  --disable-gpu --no-restore-session-state --user-data-dir=/c/Users/小渊/.agent-browser/cdp-k3 \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!
echo "[run] chrome pid=$CHROME_PID"

# 等待 CDP 就绪（最多 12 秒）
for i in $(seq 1 12); do
  if curl -s --max-time 2 http://127.0.0.1:9445/json/version >/dev/null 2>&1; then
    echo "[run] cdp ready after ${i}s"; break
  fi
  sleep 1
done

"$NODE" cdp-drive.mjs 9445 walk-delete-dialog.mjs
RC=$?
echo "[run] cdp-drive exit=$RC"

taskkill //F //IM chrome.exe >/dev/null 2>&1
exit $RC
