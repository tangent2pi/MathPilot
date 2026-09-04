#!/usr/bin/env python3
"""Preflight validator for the Pi ER result contract.

The host repeats these checks before accepting ``respond``. This copy exists
inside the Skill so a model can repair a result without guessing why it was
rejected.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path


def text(value):
    return isinstance(value, str) and bool(value.strip())


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


def input_file(workspace, reference):
    if not isinstance(reference, str) or not reference or Path(reference).is_absolute():
        return None
    normalized = reference.replace("\\", "/")
    if normalized == "." or normalized.startswith("../") or "/../" in normalized or "\x00" in normalized:
        return None
    candidate = workspace / (normalized if normalized.startswith("input/") else f"input/{normalized}")
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    root = (workspace / "input").resolve()
    return resolved if root in resolved.parents and resolved.is_file() else None


def frozen_dimensions(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    rows = value.get("questions", value) if isinstance(value, dict) else value
    dimensions = set()
    if not isinstance(rows, list):
        return dimensions
    for question in rows:
        if not isinstance(question, dict):
            continue
        for dimension in question.get("measurement_dims", []):
            if text(dimension):
                dimensions.add(dimension)
        for target in question.get("measurement_targets", []):
            if isinstance(target, dict) and text(target.get("dim")):
                dimensions.add(target["dim"])
    return dimensions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("result")
    parser.add_argument("--frozen", required=True)
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--receipt")
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    result = output_file(workspace, args.result)
    if result is None:
        raise SystemExit("result must be a file below workspace/output")
    frozen_path = input_file(workspace, args.frozen)
    if frozen_path is None:
        raise SystemExit("frozen KTQ must be a file below workspace/input")
    receipt_reference = args.receipt or result.relative_to(workspace).as_posix() + ".validation.json"
    receipt = output_file(workspace, receipt_reference, allow_missing=True)
    if receipt is None:
        raise SystemExit("receipt must be below workspace/output")
    errors = []
    try:
        data = json.loads(result.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - exercised by CLI users
        print(json.dumps({"valid": False, "errors": [str(exc)]}, ensure_ascii=False))
        raise SystemExit(1)
    if not isinstance(data, dict) or data.get("schema") != "mathpilot.er-result/v1":
        errors.append("schema must be mathpilot.er-result/v1")
    error_causes = data.get("error_causes", []) if isinstance(data, dict) else []
    rules = data.get("diagnosis_rules", []) if isinstance(data, dict) else []
    reused = data.get("reused_error_causes", []) if isinstance(data, dict) else []
    reused_rules = data.get("reused_rules", []) if isinstance(data, dict) else []
    reused_ids = set()
    if not isinstance(reused, list) or any(
        not text(item.get("id") if isinstance(item, dict) else item)
        or not re.fullmatch(r"E_[A-Za-z0-9_.:-]+", item.get("id") if isinstance(item, dict) else item)
        for item in reused
    ):
        errors.append("reused_error_causes must contain E_ identifiers")
    else:
        reused_ids.update(item.get("id") if isinstance(item, dict) else item for item in reused)
    if not isinstance(reused_rules, list) or any(
        not text(item.get("id") if isinstance(item, dict) else item)
        or not re.fullmatch(r"R_[A-Za-z0-9_.:-]+", item.get("id") if isinstance(item, dict) else item)
        for item in reused_rules
    ):
        errors.append("reused_rules must contain R_ identifiers")
    if not isinstance(error_causes, list) or not isinstance(rules, list):
        errors.append("error_causes and diagnosis_rules must be arrays")
        error_causes, rules = [], []
    error_ids = set()
    for index, item in enumerate(error_causes):
        if not isinstance(item, dict) or not re.fullmatch(r"E_[A-Za-z0-9_.:-]+", str(item.get("id"))) or not text(item.get("name")) or not text(item.get("description")):
            errors.append(f"error_causes[{index}] invalid")
        elif item["id"] in error_ids:
            errors.append(f"duplicate error id {item['id']}")
        else:
            error_ids.add(item["id"])
    try:
        dimensions = frozen_dimensions(frozen_path)
    except Exception as exc:
        dimensions = set()
        errors.append(f"frozen KTQ invalid: {exc}")
    rule_ids = set()
    for index, item in enumerate(rules):
        if not isinstance(item, dict) or not re.fullmatch(r"R_[A-Za-z0-9_.:-]+", str(item.get("id"))) or not text(item.get("trigger")) or not text(item.get("probe")):
            errors.append(f"diagnosis_rules[{index}] invalid")
            continue
        if item["id"] in rule_ids:
            errors.append(f"duplicate rule id {item['id']}")
        rule_ids.add(item["id"])
        candidates = item.get("candidate_error_causes")
        if not isinstance(candidates, list) or not candidates or any(not text(identifier) or (identifier not in error_ids and identifier not in reused_ids) for identifier in candidates):
            errors.append(f"diagnosis_rules[{index}].candidate_error_causes unresolved")
        rule_dimensions = item.get("dimension_ids")
        if not isinstance(rule_dimensions, list) or not rule_dimensions or any(not text(identifier) for identifier in rule_dimensions):
            errors.append(f"diagnosis_rules[{index}].dimension_ids invalid")
        elif dimensions and any(identifier not in dimensions for identifier in rule_dimensions):
            errors.append(f"diagnosis_rules[{index}].dimension_ids not in frozen KTQ")
        citations = item.get("citations")
        if not isinstance(citations, list) or any(not isinstance(citation, dict) or not text(citation.get("url")) or not re.match(r"^https?://", citation["url"], re.I) or not text(citation.get("title")) for citation in citations):
            errors.append(f"diagnosis_rules[{index}].citations invalid")
    if errors:
        print(json.dumps({"valid": False, "errors": errors}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    digest = hashlib.sha256(result.read_bytes()).hexdigest()
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({
        "schema": "mathpilot.validation-receipt/v1",
        "skill": "er-research",
        "result_file": result.relative_to(workspace).as_posix(),
        "sha256": digest,
        "valid": True,
        "error_cause_count": len(error_causes),
        "rule_count": len(rules),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(receipt, 0o600)
    print(json.dumps({"valid": True, "sha256": digest, "error_causes": len(error_causes), "rules": len(rules), "receipt": str(receipt)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
