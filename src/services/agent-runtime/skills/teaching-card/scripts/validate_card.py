#!/usr/bin/env python3
import json,re,sys
from pathlib import Path
if len(sys.argv)!=2: raise SystemExit("usage: validate_card.py card.json")
d=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")); errors=[]
if d.get("schema")!="agmath.question-card/v1": errors.append("invalid schema")
if not isinstance(d.get("card_id"),str) or not re.fullmatch(r"[A-Za-z0-9_-]{4,80}",d["card_id"]): errors.append("invalid card_id")
if not isinstance(d.get("prompt_markdown"),str) or not d["prompt_markdown"].strip(): errors.append("prompt_markdown required")
if d.get("response_type") not in {"single_choice","multiple_choice","fill_blank","true_false","free_text"}: errors.append("invalid response_type")
if d.get("allow_skip") is not True or d.get("allow_free_text") is not True: errors.append("skip and free text must remain available")
if any(k in d for k in ("correct","is_correct","mastery_update","score")): errors.append("card must not grade or mutate mastery")
if errors: print(json.dumps({"valid":False,"errors":errors},ensure_ascii=False,indent=2)); raise SystemExit(1)
print(json.dumps({"valid":True,"card_id":d["card_id"]},ensure_ascii=False))
