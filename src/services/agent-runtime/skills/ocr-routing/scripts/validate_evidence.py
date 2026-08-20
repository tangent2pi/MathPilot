#!/usr/bin/env python3
import argparse,json
from pathlib import Path
ap=argparse.ArgumentParser(); ap.add_argument("evidence"); ap.add_argument("--workspace",default="/workspace"); a=ap.parse_args()
w=Path(a.workspace).resolve(); d=json.loads(Path(a.evidence).read_text(encoding="utf-8")); errors=[]
if d.get("schema")!="agmath.ocr-evidence/v1": errors.append("invalid schema")
for field in ("original",):
    p=(w/d.get(field,"")).resolve()
    if w not in p.parents or not p.is_file(): errors.append(f"{field} missing or unsafe")
if not isinstance(d.get("ocr_used"),bool) or not isinstance(d.get("verified_against_original"),bool): errors.append("boolean routing fields required")
if not isinstance(d.get("reason"),str) or not d["reason"].strip(): errors.append("reason required")
derived=d.get("derived_files")
if not isinstance(derived,list): errors.append("derived_files must be an array")
else:
    for ref in derived:
        p=(w/ref).resolve()
        if not isinstance(ref,str) or w not in p.parents or not p.is_file(): errors.append(f"derived file missing or unsafe: {ref}")
if d.get("ocr_used") and not derived: errors.append("OCR use must retain derived evidence")
if not d.get("verified_against_original"): errors.append("derived evidence must be verified against original")
if errors: print(json.dumps({"valid":False,"errors":errors},ensure_ascii=False,indent=2)); raise SystemExit(1)
print(json.dumps({"valid":True,"ocr_used":d["ocr_used"],"derived_files":len(derived)},ensure_ascii=False))
