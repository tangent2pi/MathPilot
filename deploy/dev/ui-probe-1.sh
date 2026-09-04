#!/usr/bin/env bash
# Minimal agent-browser probe: open home, snapshot, screenshot — verify single-task session works
export PATH="$PATH:/c/Users/小渊/AppData/Roaming/npm:/c/Program Files/nodejs"
cd /d/git/mathpilot/MathPilot_next/deploy/dev
mkdir -p ui-shots

set -x
agent-browser open "http://localhost:8081/" 2>&1
agent-browser wait 3000 2>&1
agent-browser get title 2>&1
agent-browser snapshot -i -c 2>&1 | head -60
agent-browser screenshot ui-shots/01-home.png 2>&1
agent-browser close --all 2>&1
