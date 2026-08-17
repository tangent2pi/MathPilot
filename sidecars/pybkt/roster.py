"""pyBKT Roster 包装（设计：科学内核与Dream设计v1 §1.2；ADR-001 算法侧车）。

- 先验参数集（prior_only 阶段）经手工构造 fit_model 注入——pyBKT 本版本的
  fixed 参数路径存在 C++ 兼容 bug（EM_fit 对标量 fixed 值调用 .copy()），
  手工构造与 fit 产出的 fit_model 结构一致（As/Bn/pi_0/learns/forgets/slips/guesses/
  resource_names/gs_names），Roster/State 更新走同一 _predict 路径；
- 状态持久化采用"观测日志 + 重放"：状态文件为纯 JSONL（无隐藏状态），
  每次调用重放日志得到确定性掌握度——与 OATutor 移植 TS 引擎数学对拍为 0 差异；
- calibrated 阶段：fit/partial_fit 产出真实拟合参数后同样注入 Roster。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
from pyBKT.models import Model, Roster

# 参数集：bkt_prior_v1（与 packages/mastery BKT_PRIOR_V1 一致，prior_only）
DEFAULT_PRIOR = 0.3
DEFAULT_LEARNS = 0.0  # 纯诊断无学习转移（设计 §9.2）
DEFAULT_SLIPS = 0.1
DEFAULT_GUESSES = 0.2

STATE_DIR = Path(os.environ.get("PYBKT_STATE_DIR", str(Path(__file__).resolve().parent / "state")))
OBS_LOG = STATE_DIR / "observations.jsonl"
PRIOR_CACHE = STATE_DIR / "prior-cache.json"


def build_fit_model(params: dict) -> dict:
    """由参数集构造 fit_model（单资源/单子部分，与 fit 产物同构）。"""
    prior = float(params.get("probMastery", DEFAULT_PRIOR))
    learns = float(params.get("probTransit", DEFAULT_LEARNS))
    slips = float(params.get("probSlip", DEFAULT_SLIPS))
    guesses = float(params.get("probGuess", DEFAULT_GUESSES))
    As = np.array([[1.0 - learns, learns], [0.0, 1.0]])
    Bn = np.array([[1.0 - guesses, guesses], [slips, 1.0 - slips]])
    return {
        "As": As,
        "Bn": Bn,
        "pi_0": np.array([[1.0 - prior], [prior]]),
        "learns": np.array([learns]),
        "forgets": np.array([0.0]),
        "slips": np.array([slips]),
        "guesses": np.array([guesses]),
        "prior": prior,
        "resource_names": {"default": 0},
        "gs_names": {"default": 0},
    }


class RosterStore:
    """观测日志 + 重放的确定性掌握度状态（无隐藏状态）。"""

    def __init__(self, params: dict | None = None) -> None:
        self.params = params or {}
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.observations: list[dict] = []
        if OBS_LOG.exists():
            for line in OBS_LOG.read_text("utf-8").splitlines():
                line = line.strip()
                if line:
                    self.observations.append(json.loads(line))

    def _model(self) -> Model:
        m = Model(seed=1)
        m.fit_model = {skill: build_fit_model(self.params) for skill in self.skills()}
        return m

    def skills(self) -> list[str]:
        return sorted({o["dimension_id"] for o in self.observations})

    def students(self) -> list[str]:
        return sorted({o["student_id"] for o in self.observations})

    def append(self, obs: dict) -> None:
        """追加观测并落盘；order_id 为幂等键，重复投递静默跳过（设计 §15.2 全链路幂等）。"""
        if any(o["order_id"] == obs["order_id"] for o in self.observations):
            return
        self.observations.append(obs)
        with OBS_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(obs, ensure_ascii=False) + "\n")

    def mastery(self, student_id: str, dimension_id: str) -> float | None:
        """重放该学生该维度观测序列，返回确定性掌握度；无观测返回 None。"""
        seq = [o for o in self.observations
               if o["student_id"] == student_id and o["dimension_id"] == dimension_id]
        if not seq:
            return None
        roster = Roster(self.students(), self.skills(), mastery_state=0.95, model=self._model())
        for o in seq:
            roster.update_state(o["dimension_id"], o["student_id"], 1 if o["outcome"] == "success" else 0)
        return float(roster.get_mastery_prob(dimension_id, student_id))
