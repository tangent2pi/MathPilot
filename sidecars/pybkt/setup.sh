#!/usr/bin/env bash
# pyBKT 侧车环境安装（nix develop 或容器内运行）。
# 科学计算栈锁定到 Python 3.11/3.12 均有 manylinux wheel 的组合；镜像使用 Debian/glibc，
# 不依赖宿主环境，也不在构建时临时编译 numpy/scikit-learn。
set -eu
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/python - <<'PY'
import sys
if not ((3, 11) <= sys.version_info[:2] <= (3, 12)):
    raise SystemExit(f"unsupported Python {sys.version_info.major}.{sys.version_info.minor}; expected 3.11 or 3.12")
PY
.venv/bin/pip install --quiet \
  "numpy==1.26.4" \
  "pandas==2.3.3" \
  "scikit-learn==1.5.2" \
  "requests==2.32.5" \
  "pyBKT==1.4.3"

# pyBKT 纯 Python fit 路径的 numpy 兼容补丁（受控 venv 内 sed，不改克隆仓库）：
# EM_fit.py: log_likelihoods[i][0] = (1,1) 数组 在新 numpy 下不广播
EM="$(find .venv/lib -path '*/site-packages/pyBKT/fit/EM_fit.py' 2>/dev/null | head -1)"
if [ -n "$EM" ] && ! grep -q "total_loglike'].item()" "$EM"; then
  sed -i "s|log_likelihoods\[i\]\[0\] = result\['total_loglike'\]|log_likelihoods[i][0] = result['total_loglike'].item()|" "$EM"
fi

echo "pyBKT sidecar venv ready: $(.venv/bin/python -c 'import pyBKT; print(pyBKT.__file__)')"
