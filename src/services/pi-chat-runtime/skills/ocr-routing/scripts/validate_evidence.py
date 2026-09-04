#!/usr/bin/env python3
"""Validate the small durable OCR evidence manifest used by Pi Skills."""
import argparse
import json
import os
from pathlib import Path


def safe_file(root, reference, area):
    if not isinstance(reference, str) or not reference or Path(reference).is_absolute():
        return False
    normalized = reference.replace("\\", "/")
    if normalized == "." or normalized.startswith("../") or "/../" in normalized or any(part == ".." for part in normalized.split("/")) or "\x00" in normalized:
        return False
    area_root = (root / area).resolve()
    candidate = root / normalized if normalized.startswith(f"{area}/") else area_root / normalized
    try:
        path = candidate.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return False
    return area_root in path.parents and path.is_file()


def output_file(root, reference):
    if not isinstance(reference, str) or not reference or Path(reference).is_absolute():
        return None
    normalized = reference.replace("\\", "/")
    if normalized == "output" or not normalized.startswith("output/") or any(part == ".." for part in normalized.split("/")) or "\x00" in normalized:
        return None
    try:
        path = (root / normalized).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    output_root = (root / "output").resolve()
    return path if output_root in path.parents and path.is_file() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence")
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()
    root = Path(args.workspace).resolve()
    evidence = output_file(root, args.evidence)
    if evidence is None:
        raise SystemExit("evidence must be a file below workspace/output")
    try:
        data = json.loads(evidence.read_text(encoding="utf-8"))
    except Exception as exc:
        print(json.dumps({"valid": False, "errors": [str(exc)]}, ensure_ascii=False))
        raise SystemExit(1)
    errors = []
    if not isinstance(data, dict) or data.get("schema") != "mathpilot.ocr-evidence/v1":
        errors.append("invalid schema")
    if not safe_file(root, data.get("original"), "input"):
        errors.append("original missing or unsafe")
    if not isinstance(data.get("ocr_used"), bool) or not isinstance(data.get("verified_against_original"), bool):
        errors.append("boolean routing fields required")
    if not isinstance(data.get("reason"), str) or not data["reason"].strip():
        errors.append("reason required")
    derived = data.get("derived_files")
    if not isinstance(derived, list):
        errors.append("derived_files must be an array")
        derived = []
    else:
        for reference in derived:
            if not safe_file(root, reference, "output"):
                errors.append(f"derived file missing or unsafe: {reference}")
    if data.get("ocr_used") and not derived:
        errors.append("OCR use must retain derived evidence")
    if not data.get("verified_against_original"):
        errors.append("derived evidence must be verified against original")
    if errors:
        print(json.dumps({"valid": False, "errors": errors}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    os.chmod(evidence, 0o600)
    print(json.dumps({"valid": True, "ocr_used": data["ocr_used"], "derived_files": len(derived)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
