#!/usr/bin/env python3
import argparse, hashlib, json, re
from pathlib import Path

FORMATS={"single_choice","multiple_choice","fill_blank","true_false","open_solution"}
ROLES={"primary","secondary","prerequisite"}

def fail(errors, where, message): errors.append(f"{where}: {message}")
def text(v): return isinstance(v,str) and bool(v.strip())
def normalized(v): return re.sub(r"[\s，。；：！？、,.!?;:]", "", v).casefold()
def workspace_file(workspace, ref):
    direct=(workspace/ref).resolve()
    nested=(workspace/"input"/ref).resolve()
    for p in (direct,nested):
        if workspace.resolve() in p.parents and p.is_file(): return p
    return None

def validate(result_path: Path, workspace: Path):
    errors=[]
    try: data=json.loads(result_path.read_text(encoding="utf-8"))
    except Exception as exc: return None,[f"result: invalid JSON: {exc}"]
    if not isinstance(data,dict): return data,["result: must be an object"]
    if data.get("schema") != "agmath.ktq-result/v1": fail(errors,"schema","must be agmath.ktq-result/v1")
    questions=data.get("questions")
    if not isinstance(questions,list): return data,errors+["questions: must be an array"]
    seen={}
    for i,q in enumerate(questions):
        at=f"questions[{i}]"
        if not isinstance(q,dict): fail(errors,at,"must be an object"); continue
        stem=q.get("stem_markdown")
        if not text(stem): fail(errors,at+".stem_markdown","required")
        fmt=q.get("stem_format")
        if fmt not in FORMATS: fail(errors,at+".stem_format",f"unsupported: {fmt!r}")
        opts=q.get("options")
        if not isinstance(opts,list): fail(errors,at+".options","must be an array")
        elif fmt in {"single_choice","multiple_choice"} and len(opts)<2: fail(errors,at+".options","choice question needs at least two options")
        elif any(not isinstance(o,dict) or not text(o.get("key")) or not text(o.get("text_markdown")) for o in opts): fail(errors,at+".options","every option needs key and text_markdown")
        refs=q.get("image_refs")
        if not isinstance(refs,list) or any(not text(r) for r in refs): fail(errors,at+".image_refs","must be a string array")
        else:
            for ref in refs:
                if workspace_file(workspace,ref) is None: fail(errors,at+".image_refs",f"missing or unsafe path: {ref}")
        frag=q.get("source_fragment_id")
        source=q.get("source")
        if not text(frag):
            if not isinstance(source,dict) or not text(source.get("path")) or not isinstance(source.get("page"),int) or source["page"]<1: fail(errors,at+".source","source_fragment_id or source path/page required")
            else:
                if workspace_file(workspace,source["path"]) is None: fail(errors,at+".source.path",f"missing or unsafe path: {source['path']}")
        ks=q.get("knowledge_components")
        if not isinstance(ks,list) or not ks or any(not isinstance(k,dict) or not text(k.get("id")) or not k["id"].startswith("K_") or not text(k.get("name")) for k in ks): fail(errors,at+".knowledge_components","needs named K_ entries")
        qt=q.get("question_type")
        if not isinstance(qt,dict) or not text(qt.get("id")) or not qt["id"].startswith("T_") or not text(qt.get("name")): fail(errors,at+".question_type","needs named T_ entry")
        d=q.get("difficulty")
        if not isinstance(d,(int,float)) or isinstance(d,bool) or not 0<=d<=1: fail(errors,at+".difficulty","must be in [0,1]")
        mts=q.get("measurement_targets")
        if not isinstance(mts,list) or not mts or any(not isinstance(m,dict) or not text(m.get("dim")) or m.get("role") not in ROLES or not text(m.get("evidence_rule")) for m in mts): fail(errors,at+".measurement_targets","invalid or empty")
        else:
            declared={k.get("id") for k in ks if isinstance(k,dict)} if isinstance(ks,list) else set()
            if isinstance(qt,dict): declared.add(qt.get("id"))
            if any(m.get("dim") not in declared for m in mts): fail(errors,at+".measurement_targets","every dim must reference this question's K/T ID")
        rubric=q.get("rubric")
        if not isinstance(rubric,list) or not rubric or any(not isinstance(r,dict) or not text(r.get("id")) or not text(r.get("description")) for r in rubric): fail(errors,at+".rubric","invalid or empty")
        if not isinstance(q.get("answer"),dict): fail(errors,at+".answer","must be an object")
        action=q.get("dedup_action")
        if action not in {"new","duplicate","merge"}: fail(errors,at+".dedup_action","must be new, duplicate, or merge")
        if action in {"duplicate","merge"} and not text(q.get("duplicate_of")): fail(errors,at+".duplicate_of","required for duplicate/merge")
        if text(stem):
            key=normalized(stem)
            if key in seen and action=="new": fail(errors,at+".stem_markdown",f"exact normalized duplicate of questions[{seen[key]}]")
            seen.setdefault(key,i)
    return data,errors

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("result"); ap.add_argument("--workspace",default="/workspace"); ap.add_argument("--receipt")
    a=ap.parse_args(); result=Path(a.result).resolve(); workspace=Path(a.workspace).resolve()
    if workspace not in result.parents: raise SystemExit("result must be below workspace")
    data,errors=validate(result,workspace)
    if errors: print(json.dumps({"valid":False,"errors":errors},ensure_ascii=False,indent=2)); raise SystemExit(1)
    digest=hashlib.sha256(result.read_bytes()).hexdigest(); receipt=Path(a.receipt or str(result)+".validation.json")
    receipt.write_text(json.dumps({"schema":"agmath.validation-receipt/v1","skill":"ktq-extraction","result_file":result.relative_to(workspace).as_posix(),"sha256":digest,"valid":True,"question_count":len(data["questions"])},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"valid":True,"sha256":digest,"questions":len(data["questions"]),"receipt":str(receipt)},ensure_ascii=False))
if __name__=="__main__": main()
