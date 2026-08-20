#!/usr/bin/env python3
import argparse, hashlib, json
from pathlib import Path
def text(v): return isinstance(v,str) and bool(v.strip())
def main():
    ap=argparse.ArgumentParser(); ap.add_argument("result"); ap.add_argument("--frozen"); ap.add_argument("--receipt")
    a=ap.parse_args(); result=Path(a.result).resolve(); errors=[]
    try: data=json.loads(result.read_text(encoding="utf-8"))
    except Exception as exc: print(json.dumps({"valid":False,"errors":[str(exc)]})); raise SystemExit(1)
    if not isinstance(data,dict) or data.get("schema")!="mathpilot.er-result/v1": errors.append("schema must be mathpilot.er-result/v1")
    ecs=data.get("error_causes",[]); rules=data.get("diagnosis_rules",[]); reused=set(data.get("reused_error_causes",[]))
    if not isinstance(ecs,list) or not isinstance(rules,list): errors.append("error_causes and diagnosis_rules must be arrays"); ecs=[]; rules=[]
    eids=set()
    for i,e in enumerate(ecs):
        if not isinstance(e,dict) or not text(e.get("id")) or not e["id"].startswith("E_") or not text(e.get("name")) or not text(e.get("description")): errors.append(f"error_causes[{i}] invalid")
        elif e["id"] in eids: errors.append(f"duplicate error id {e['id']}")
        else: eids.add(e["id"])
    frozen_dims=set()
    if a.frozen:
        try:
            frozen=json.loads(Path(a.frozen).read_text(encoding="utf-8")); rows=frozen.get("questions",frozen) if isinstance(frozen,dict) else frozen
            for q in rows:
                frozen_dims.update(q.get("measurement_dims",[])); frozen_dims.update(m.get("dim") for m in q.get("measurement_targets",[]) if isinstance(m,dict))
        except Exception as exc: errors.append(f"frozen KTQ invalid: {exc}")
    rids=set()
    for i,r in enumerate(rules):
        if not isinstance(r,dict) or not text(r.get("id")) or not r["id"].startswith("R_") or not text(r.get("trigger")) or not text(r.get("probe")): errors.append(f"diagnosis_rules[{i}] invalid"); continue
        if r["id"] in rids: errors.append(f"duplicate rule id {r['id']}")
        rids.add(r["id"]); candidates=r.get("candidate_error_causes"); dims=r.get("dimension_ids")
        if not isinstance(candidates,list) or not candidates or any(e not in eids and e not in reused for e in candidates): errors.append(f"diagnosis_rules[{i}].candidate_error_causes unresolved")
        if not isinstance(dims,list) or not dims or any(not text(d) for d in dims): errors.append(f"diagnosis_rules[{i}].dimension_ids invalid")
        elif frozen_dims and any(d not in frozen_dims for d in dims): errors.append(f"diagnosis_rules[{i}].dimension_ids not in frozen KTQ")
        elif not frozen_dims and any(not d.startswith(("K_","T_")) for d in dims): errors.append(f"diagnosis_rules[{i}].dimension_ids must use K/T IDs")
        citations=r.get("citations",[])
        if not isinstance(citations,list) or any(not isinstance(c,dict) or not text(c.get("url")) or not text(c.get("title")) for c in citations): errors.append(f"diagnosis_rules[{i}].citations invalid")
    if errors: print(json.dumps({"valid":False,"errors":errors},ensure_ascii=False,indent=2)); raise SystemExit(1)
    digest=hashlib.sha256(result.read_bytes()).hexdigest(); receipt=Path(a.receipt or str(result)+".validation.json")
    receipt.write_text(json.dumps({"schema":"mathpilot.validation-receipt/v1","skill":"er-research","result_file":result.name if result.parent.name=="output" else str(result),"sha256":digest,"valid":True,"error_cause_count":len(ecs),"rule_count":len(rules)},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"valid":True,"sha256":digest,"error_causes":len(ecs),"rules":len(rules),"receipt":str(receipt)},ensure_ascii=False))
if __name__=="__main__": main()
