#!/usr/bin/env bash
# Single-task multi-command sanity: open -> title -> snapshot -i, same bash process
export PATH="$PATH:/c/Users/小渊/AppData/Roaming/npm:/c/Program Files/nodejs"
cd /d/git/mathpilot/MathPilot_next/deploy/dev
mkdir -p ui-shots
LOG=ui-shots/sanity.log
: > "$LOG"

agent-browser close --all >>"$LOG" 2>&1
rm -f ~/.agent-browser/default.pid ~/.agent-browser/default.port ~/.agent-browser/default.stream ~/.agent-browser/default.engine ~/.agent-browser/default.version

echo "== open ==" >>"$LOG"
timeout 50 agent-browser open "http://localhost:8081/" >>"$LOG" 2>&1
echo "open_exit=$?" >>"$LOG"

echo "== title ==" >>"$LOG"
timeout 15 agent-browser get title >>"$LOG" 2>&1
echo "title_exit=$?" >>"$LOG"

echo "== snapshot -i ==" >>"$LOG"
timeout 25 agent-browser snapshot -i -c >>"$LOG" 2>&1
echo "snap_exit=$?" >>"$LOG"

echo "== screenshot ==" >>"$LOG"
timeout 20 agent-browser screenshot ui-shots/sanity-home.png >>"$LOG" 2>&1
echo "shot_exit=$?" >>"$LOG"

agent-browser close --all >>"$LOG" 2>&1
cat "$LOG"
