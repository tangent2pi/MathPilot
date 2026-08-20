#!/usr/bin/env bash
# 侧车契约测试：与 OATutor 移植 TS 引擎对拍（差异必须为 0）
set -eu
cd "$(dirname "$0")"

# 独立状态目录（幂等：重复运行不叠加观测）
export PYBKT_STATE_DIR="$(mktemp -d)"

# 1. roster_update 序列（success, success, failure）→ p_mastery
SEQ=$(printf '%s\n' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_1"}' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_2"}' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"failure","order_id":"obs_3"}' \
  | .venv/bin/python cli.py | python3 -c 'import json,sys; print(json.loads(sys.stdin.readlines()[-1])["value"]["p_mastery"])')
echo "pyBKT p_mastery after S,S,F = $SEQ"

# 2. TS 引擎同序列（node 调用 packages/mastery）
TS=$(node -e "
import('./../../src/packages/mastery/src/index.ts').then(m => {
  const p = m.bktReplay(['success','success','failure']);
  console.log(p.toFixed(12));
});")
echo "TS  OATutor p_mastery after S,S,F = $TS"

# 3. 对拍（全精度：差异应 < 1e-9）
python3 - "$SEQ" "$TS" <<'PY'
import sys
a, b = float(sys.argv[1]), float(sys.argv[2])
if abs(a - b) > 1e-9:
    print(f"FAIL: pyBKT {a} != TS {b}")
    sys.exit(1)
print(f"OK: 对拍差异 = {abs(a-b)}")
PY

# 4. roster_get 无观测
echo '{"op":"roster_get","student_id":"usr_02","dimension_id":"K_SSA"}' \
  | .venv/bin/python cli.py | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["value"]["p_mastery"] is None; print("OK: 无观测返回 null")'

# 5. fit 冒烟（真实 EM 路径）
python3 - <<'PY' | .venv/bin/python cli.py | python3 -c 'import json,sys; d=json.loads(sys.stdin.readlines()[-1]); assert d["ok"] and d["value"]["parameters"], d; print("OK: fit 冒烟", list(d["value"]["parameters"].keys()))'
import json, random
random.seed(7)
for i in range(2):
    print(json.dumps({"op":"fit","parameter_set_id":"bkt_cal_smoke","rows":[
        {"student_id":f"s{j%8}","dimension_id":"K_SSA","outcome":"success" if random.random()<0.6 else "failure","order_id":f"f{i}_{j}"}
        for j in range(10)]}))
PY

# 6. supersede 语义（P0-8）：旧观测被取代后重放排除，与"直接不追加旧观测"结果一致
export PYBKT_STATE_DIR="$(mktemp -d)"
printf '%s\n' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_1"}' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"failure","order_id":"obs_2"}' \
  | .venv/bin/python cli.py >/dev/null
BEFORE=$(printf '%s\n' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_3","supersedes":"obs_2"}' \
  | .venv/bin/python cli.py | python3 -c 'import json,sys; print(json.loads(sys.stdin.readlines()[-1])["value"]["p_mastery"])')
# 对照：obs_2 从未出现过（只有 obs_1 success + obs_3 success）
export PYBKT_STATE_DIR="$(mktemp -d)"
CONTROL=$(printf '%s\n' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_1"}' \
  '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_3"}' \
  | .venv/bin/python cli.py | python3 -c 'import json,sys; print(json.loads(sys.stdin.readlines()[-1])["value"]["p_mastery"])')
python3 - "$BEFORE" "$CONTROL" <<'PY'
import sys
a, b = float(sys.argv[1]), float(sys.argv[2])
if abs(a - b) > 1e-9:
    print(f"FAIL: supersede 重放 {a} != 无旧观测对照 {b}")
    sys.exit(1)
print(f"OK: supersede 后重放与无旧观测一致（{a}）")
PY

echo "SIDECAR TESTS PASS"
