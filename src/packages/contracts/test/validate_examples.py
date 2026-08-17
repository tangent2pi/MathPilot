#!/usr/bin/env python3
"""契约样例校验（ADR-003）。

规则：
- 每个 *.examples.json 的 valid 必须通过对应 schema 校验；
- missing_field 必须被拒绝（identity $defs 库除外，无根实例语义）；
- invalid_source 为说明性反例，由更高层契约测试（权限/来源/越界）覆盖。

运行（仓库根目录）：
  nix shell --impure --expr 'with import (builtins.getFlake "nixpkgs") { system = "x86_64-linux"; }; python3.withPackages (ps: [ ps.jsonschema ps.referencing ])' -c python3 src/packages/contracts/test/validate_examples.py
"""
import json
import glob
import sys
from pathlib import Path
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

# 以脚本自身定位 schemas，任意 cwd 可跑；glob 零命中视为失败（防路径漂移假阳性）
ROOT = str(Path(__file__).resolve().parent.parent / "schemas")


def main() -> int:
    schemas = {}
    for f in glob.glob(f"{ROOT}/**/*.schema.json", recursive=True):
        with open(f) as fh:
            s = json.load(fh)
        schemas[s["$id"]] = s
    registry = Registry()
    for sid, s in schemas.items():
        registry = registry.with_resource(sid, Resource.from_contents(s))

    failures = []
    example_files = sorted(glob.glob(f"{ROOT}/**/*.examples.json", recursive=True))
    for f in example_files:
        with open(f.replace(".examples.json", ".schema.json")) as fh:
            schema = json.load(fh)
        with open(f) as fh:
            examples = json.load(fh)
        v = Draft202012Validator(schema, registry=registry)
        is_identity = schema["$id"].endswith("identity/v1")

        valid = examples["valid"]
        if is_identity:
            for key, val in valid.items():
                if key == "note":
                    continue
                dv = Draft202012Validator(
                    {"$ref": f"https://schemas.agmath.dev/common/identity/v1#/$defs/{key}"},
                    registry=registry,
                )
                errs = list(dv.iter_errors(val))
                if errs:
                    failures.append((f, f"valid.{key}", errs[0].message))
        else:
            errs = list(v.iter_errors(valid))
            if errs:
                failures.append((f, "valid", errs[0].message))
            mf = {k: val for k, val in examples["missing_field"].items() if not k.startswith("_")}
            if not list(v.iter_errors(mf)):
                failures.append((f, "missing_field", "expected to FAIL but passed"))

    print(f"checked {len(example_files)} example files against {len(schemas)} schemas")
    if len(example_files) == 0 or len(schemas) == 0:
        print("FAIL: no schemas/examples found — ROOT path drifted")
        return 1
    if failures:
        for f, case, msg in failures:
            print(f"  FAIL {f} [{case}]: {msg[:200]}")
        return 1
    print("PASS: all valid examples validate; all missing_field examples are rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
