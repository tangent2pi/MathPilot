#!/usr/bin/env python3
"""Preflight validator for the Pi KTQ result contract.

The Pi host repeats the security-sensitive checks in TypeScript. This small
script gives the model a deterministic local feedback loop and writes the
same receipt shape that the host accepts.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

FORMATS = {"single_choice", "multiple_choice", "fill_blank", "true_false", "open_solution"}
ROLES = {"primary", "secondary", "prerequisite"}


def text(value):
    return isinstance(value, str) and bool(value.strip())


def normalized(value):
    return re.sub(r"[\s，。；：！？、,.!?;:]", "", value).casefold()


def workspace_file(workspace, reference):
    if not isinstance(reference, str) or not reference or Path(reference).is_absolute():
        return None
    normalized_ref = reference.replace("\\", "/")
    if normalized_ref == "." or normalized_ref.startswith("../") or "/../" in normalized_ref:
        return None
    if "\x00" in normalized_ref:
        return None
    root = (workspace / "input").resolve()
    candidates = ((workspace / normalized_ref,) if normalized_ref.startswith("input/")
                  else (root / normalized_ref,))
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            continue
        if root in resolved.parents and resolved.is_file():
            return resolved
    return None


def output_file(workspace, reference, allow_missing=False):
    if not isinstance(reference, str) or not reference or Path(reference).is_absolute():
        return None
    normalized = reference.replace("\\", "/")
    if normalized == "output" or not normalized.startswith("output/") or any(part == ".." for part in normalized.split("/")) or "\x00" in normalized:
        return None
    try:
        resolved = (workspace / normalized).resolve(strict=not allow_missing)
    except (OSError, RuntimeError, ValueError):
        return None
    root = (workspace / "output").resolve()
    if root not in resolved.parents:
        return None
    if not allow_missing and not resolved.is_file():
        return None
    return resolved


def fail(errors, where, message):
    errors.append(f"{where}: {message}")


def validate(result_path, workspace):
    errors = []
    try:
        data = json.loads(result_path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - exercised by CLI users
        return None, [f"result: invalid JSON: {exc}"]
    if not isinstance(data, dict):
        return data, ["result: must be an object"]
    if data.get("schema") != "mathpilot.ktq-result/v1":
        fail(errors, "schema", "must be mathpilot.ktq-result/v1")
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        return data, errors + ["questions: must be a non-empty array"]
    seen = {}
    for index, question in enumerate(questions):
        at = f"questions[{index}]"
        if not isinstance(question, dict):
            fail(errors, at, "must be an object")
            continue
        stem = question.get("stem_markdown")
        if not text(stem):
            fail(errors, at + ".stem_markdown", "required")
        fmt = question.get("stem_format")
        if fmt not in FORMATS:
            fail(errors, at + ".stem_format", f"unsupported: {fmt!r}")
        options = question.get("options")
        if not isinstance(options, list):
            fail(errors, at + ".options", "must be an array")
        elif fmt in {"single_choice", "multiple_choice"} and len(options) < 2:
            fail(errors, at + ".options", "choice question needs at least two options")
        elif any(not isinstance(option, dict) or not text(option.get("key")) or not text(option.get("text_markdown")) for option in options):
            fail(errors, at + ".options", "every option needs key and text_markdown")
        refs = question.get("image_refs")
        if not isinstance(refs, list) or any(not text(ref) for ref in refs):
            fail(errors, at + ".image_refs", "must be a string array")
        else:
            for ref in refs:
                if workspace_file(workspace, ref) is None:
                    fail(errors, at + ".image_refs", f"missing or unsafe path: {ref}")
        fragment = question.get("source_fragment_id")
        source = question.get("source")
        if not text(fragment):
            if not isinstance(source, dict) or not text(source.get("path")) or not isinstance(source.get("page"), int) or isinstance(source.get("page"), bool) or source["page"] < 1:
                fail(errors, at + ".source", "source_fragment_id or source path/page required")
            elif workspace_file(workspace, source["path"]) is None:
                fail(errors, at + ".source.path", f"missing or unsafe path: {source['path']}")
        components = question.get("knowledge_components")
        if not isinstance(components, list) or not components or any(not isinstance(component, dict) or not re.fullmatch(r"K_[A-Za-z0-9_.:-]+", str(component.get("id"))) or not text(component.get("name")) for component in components):
            fail(errors, at + ".knowledge_components", "needs named K_ entries")
        question_type = question.get("question_type")
        if not isinstance(question_type, dict) or not re.fullmatch(r"T_[A-Za-z0-9_.:-]+", str(question_type.get("id"))) or not text(question_type.get("name")):
            fail(errors, at + ".question_type", "needs named T_ entry")
        difficulty = question.get("difficulty")
        if isinstance(difficulty, bool) or not isinstance(difficulty, (int, float)) or not 0 <= difficulty <= 1:
            fail(errors, at + ".difficulty", "must be in [0,1]")
        targets = question.get("measurement_targets")
        if not isinstance(targets, list) or not targets or any(not isinstance(target, dict) or not text(target.get("dim")) or target.get("role") not in ROLES or not text(target.get("evidence_rule")) for target in targets):
            fail(errors, at + ".measurement_targets", "invalid or empty")
        else:
            declared = {component.get("id") for component in components if isinstance(component, dict)} if isinstance(components, list) else set()
            if isinstance(question_type, dict):
                declared.add(question_type.get("id"))
            if any(target.get("dim") not in declared for target in targets):
                fail(errors, at + ".measurement_targets", "every dim must reference this question's K/T ID")
        rubric = question.get("rubric")
        if not isinstance(rubric, list) or not rubric or any(not isinstance(item, dict) or not text(item.get("id")) or not text(item.get("description")) for item in rubric):
            fail(errors, at + ".rubric", "invalid or empty")
        if not isinstance(question.get("answer"), dict):
            fail(errors, at + ".answer", "must be an object")
        action = question.get("dedup_action")
        if action not in {"new", "duplicate", "merge"}:
            fail(errors, at + ".dedup_action", "must be new, duplicate, or merge")
        if action in {"duplicate", "merge"} and not text(question.get("duplicate_of")):
            fail(errors, at + ".duplicate_of", "required for duplicate/merge")
        if text(stem):
            key = normalized(stem)
            if key in seen and action == "new":
                fail(errors, at + ".stem_markdown", f"exact normalized duplicate of questions[{seen[key]}]")
            seen.setdefault(key, index)
    return data, errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("result")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--receipt")
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    result = output_file(workspace, args.result)
    if result is None:
        raise SystemExit("result must be a file below workspace/output")
    receipt_reference = args.receipt or result.relative_to(workspace).as_posix() + ".validation.json"
    receipt = output_file(workspace, receipt_reference, allow_missing=True)
    if receipt is None:
        raise SystemExit("receipt must be below workspace/output")
    data, errors = validate(result, workspace)
    if errors:
        print(json.dumps({"valid": False, "errors": errors}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    digest = hashlib.sha256(result.read_bytes()).hexdigest()
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({
        "schema": "mathpilot.validation-receipt/v1",
        "skill": "ktq-extraction",
        "result_file": result.relative_to(workspace).as_posix(),
        "sha256": digest,
        "valid": True,
        "question_count": len(data["questions"]),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(receipt, 0o600)
    print(json.dumps({"valid": True, "sha256": digest, "questions": len(data["questions"]), "receipt": str(receipt)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
