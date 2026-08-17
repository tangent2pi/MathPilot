#!/usr/bin/env bash
# pyBKT 侧车环境安装（nix develop 内运行）：
#   依赖钉版（pyBKT 兼容）：numpy<2（C 扩展需 1.x 头）、scikit-learn<1.6（metrics 兼容）
set -eu
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --quiet "numpy<2" "pandas" "scikit-learn<1.6" "requests" "pyBKT"

# pyBKT 纯 Python fit 路径的 numpy 兼容补丁（受控 venv 内 sed，不改克隆仓库）：
# EM_fit.py: log_likelihoods[i][0] = (1,1) 数组 在新 numpy 下不广播
EM=".venv/lib/python3.12/site-packages/pyBKT/fit/EM_fit.py"
if [ -f "$EM" ] && ! grep -q "total_loglike'].item()" "$EM"; then
  sed -i "s|log_likelihoods\[i\]\[0\] = result\['total_loglike'\]|log_likelihoods[i][0] = result['total_loglike'].item()|" "$EM"
fi

echo "pyBKT sidecar venv ready: $(.venv/bin/python -c 'import pyBKT; print(pyBKT.__file__)')"
