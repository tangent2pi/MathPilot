#!/usr/bin/env python3
from pathlib import Path
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else "/opt/mathpilot-skills/search")
required=(root/"SKILL.md",root/"agents/openai.yaml",root/"assets/research-note-template.json")
missing=[str(p) for p in required if not p.is_file()]
if missing: print("missing: "+", ".join(missing)); raise SystemExit(1)
print("search_skill_install=valid")
