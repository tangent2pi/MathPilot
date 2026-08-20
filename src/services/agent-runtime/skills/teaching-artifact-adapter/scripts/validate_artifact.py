#!/usr/bin/env python3
import hashlib,json,re,sys
from pathlib import Path
if len(sys.argv)!=2: raise SystemExit("usage: validate_artifact.py ARTIFACT_DIR")
root=Path(sys.argv[1]).resolve(); manifest=root/"manifest.json"; errors=[]
try: d=json.loads(manifest.read_text(encoding="utf-8"))
except Exception as exc: print(exc); raise SystemExit(1)
if d.get("schema")!="agmath.learning-artifact/v1": errors.append("invalid schema")
if d.get("renderer") not in {"sandboxed_html","native_card","media"}: errors.append("invalid renderer")
entry=d.get("entry",""); ep=(root/entry).resolve()
if root not in ep.parents or not ep.is_file(): errors.append("entry missing or unsafe")
policy=d.get("response_policy",{})
if policy.get("allow_skip") is not True or policy.get("allow_free_text_without_answer") is not True: errors.append("non-blocking response policy required")
for item in d.get("files",[]):
    p=(root/item.get("path","")).resolve()
    if root not in p.parents or not p.is_file(): errors.append(f"missing file {item.get('path')}"); continue
    digest="sha256:"+hashlib.sha256(p.read_bytes()).hexdigest()
    if item.get("content_hash")!=digest or item.get("byte_size")!=p.stat().st_size: errors.append(f"hash/size mismatch {item.get('path')}")
if d.get("renderer")=="sandboxed_html" and ep.is_file():
    html=ep.read_text(encoding="utf-8",errors="replace")
    if re.search(r"https?://|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage",html,re.I): errors.append("HTML contains network or storage capability")
if errors: print(json.dumps({"valid":False,"errors":errors},ensure_ascii=False,indent=2)); raise SystemExit(1)
print(json.dumps({"valid":True,"artifact_id":d.get("artifact_id")},ensure_ascii=False))
