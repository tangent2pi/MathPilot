#!/usr/bin/env python3
import json,re,sys
from pathlib import Path
if len(sys.argv)!=2: raise SystemExit("usage: validate_card.py card.json")
p=Path(sys.argv[1]); d=json.loads(p.read_text(encoding="utf-8")); errors=[]
if d.get("schema")!="mathpilot.question-card/v1": errors.append("invalid schema")
artifact_id=d.get("artifact_id")
if not isinstance(artifact_id,str) or not re.fullmatch(r"art_[A-Za-z0-9]{8,92}",artifact_id): errors.append("invalid artifact_id")
if p.parent.name.startswith("art_") and artifact_id!=p.parent.name: errors.append("artifact_id must match artifact directory")
if not isinstance(d.get("card_id"),str) or not re.fullmatch(r"card_[A-Za-z0-9]+",d["card_id"]): errors.append("invalid card_id")
if not isinstance(d.get("prompt"),str) or not d["prompt"].strip(): errors.append("prompt required")
if d.get("type") not in {"single_choice","multiple_choice","fill_blank","true_false","short_answer"}: errors.append("invalid type")
policy=d.get("response_policy")
if policy!={"required":False,"allow_skip":True,"allow_free_text_without_answer":True}: errors.append("invalid optional response_policy")
if d.get("evidence_policy") not in {"teaching_only","eligible_if_independent"}: errors.append("invalid evidence_policy")
if any(k in d for k in ("correct","is_correct","mastery_update","score")): errors.append("card must not grade or mutate mastery")
if errors: print(json.dumps({"valid":False,"errors":errors},ensure_ascii=False,indent=2)); raise SystemExit(1)
print(json.dumps({"valid":True,"card_id":d["card_id"]},ensure_ascii=False))
