#!/usr/bin/env bash
# Learn login page structure — self-contained task: open -> wait -> snapshot -> close
export PATH="$PATH:/c/Users/小渊/AppData/Roaming/npm:/c/Program Files/nodejs"
cd /d/git/mathpilot/MathPilot_next/deploy/dev
mkdir -p ui-shots

agent-browser close --all >/dev/null 2>&1
echo "== open =="
timeout 40 agent-browser open "http://localhost:8081/" 2>&1
echo "EXIT_OPEN=$?"
echo "== wait =="
timeout 20 agent-browser wait 6000 2>&1
echo "EXIT_WAIT=$?"
echo "== title =="
timeout 15 agent-browser get title 2>&1
echo "== snapshot full (head 100) =="
timeout 30 agent-browser snapshot 2>&1 | head -100
echo "EXIT_SNAP=$?"
echo "== screenshot =="
timeout 20 agent-browser screenshot ui-shots/01-home.png 2>&1
echo "EXIT_SHOT=$?"
timeout 15 agent-browser close --all 2>&1
