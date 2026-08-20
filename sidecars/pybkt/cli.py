#!/usr/bin/env python3
"""pyBKT 侧车 CLI（ADR-001：Python 只作算法侧车，经 stdin JSON-lines → stdout JSON）。

操作契约（科学内核与Dream设计v1 §1.2）：
  {"op":"roster_update","student_id","dimension_id","outcome":"success|failure","order_id"}
      → {"ok":true,"value":{"p_mastery":0.6585},"parameter_set_id":"bkt_prior_v1"}
  {"op":"roster_get","student_id","dimension_id"}
      → {"ok":true,"value":{"p_mastery":0.6585},"parameter_set_id":"bkt_prior_v1"}
  {"op":"fit","parameter_set_id","rows":[{"student_id","dimension_id","outcome","order_id"}]}
      → {"ok":true,"value":{"parameters":{"K_SSA":{"probMastery":..,"probTransit":..,"probSlip":..,"probGuess":..}}}}
  {"op":"predict","rows":[...]}  → {"ok":true,"value":{"predictions":[{"p_correct":..,"p_mastery":..}]}}

状态：sidecars/pybkt/state/observations.jsonl（纯文件，无隐藏状态）。
"""

from __future__ import annotations

import json
import sys

import pandas as pd

from roster import DEFAULT_GUESSES, DEFAULT_LEARNS, DEFAULT_PRIOR, DEFAULT_SLIPS, RosterStore


def op_roster_update(store: RosterStore, req: dict) -> dict:
    student_id, dim = req.get("student_id"), req.get("dimension_id")
    outcome, order_id = req.get("outcome"), req.get("order_id")
    supersedes = req.get("supersedes")
    if not student_id or not dim or outcome not in ("success", "failure") or not order_id:
        return {"ok": False, "error": "invalid_request", "detail": "student_id/dimension_id/outcome/order_id 必填"}
    obs = {"student_id": student_id, "dimension_id": dim, "outcome": outcome, "order_id": order_id}
    if supersedes:
        obs["supersedes"] = supersedes
    store.append(obs)
    p = store.mastery(student_id, dim)
    return {"ok": True, "value": {"p_mastery": p}, "parameter_set_id": "bkt_prior_v1"}


def op_roster_get(store: RosterStore, req: dict) -> dict:
    student_id, dim = req.get("student_id"), req.get("dimension_id")
    if not student_id or not dim:
        return {"ok": False, "error": "invalid_request", "detail": "student_id/dimension_id 必填"}
    p = store.mastery(student_id, dim)
    if p is None:
        return {"ok": True, "value": {"p_mastery": None}, "parameter_set_id": "bkt_prior_v1", "note": "无观测"}

    return {"ok": True, "value": {"p_mastery": p}, "parameter_set_id": "bkt_prior_v1"}


def op_fit(req: dict) -> dict:
    """批量拟合（calibrated 阶段）：pyBKT EM 全量拟合，产出参数集。"""
    from pyBKT.models import Model

    rows = req.get("rows") or []
    if not rows:
        return {"ok": False, "error": "invalid_request", "detail": "rows 必填"}
    df = pd.DataFrame([{
        # order_id 仅用于时序（pyBKT 要求数字）；原始 order_id 由幂等去重保证唯一性
        "order_id": idx, "skill_name": r["dimension_id"],
        "correct": 1 if r["outcome"] == "success" else 0, "user_id": r["student_id"],
    } for idx, r in enumerate(rows)])
    model = Model(seed=1)
    skills = sorted(df["skill_name"].unique())
    model.fit(data=df, skills=skills, num_fits=3)
    # params() 为长表（MultiIndex: skill, param, class）
    params = {}
    for (skill, param, _), row in model.params().iterrows():
        params.setdefault(skill, {})[param] = float(row["value"])
    # 统一为 OATutor 参数 schema（probMastery/probTransit/probSlip/probGuess）
    out = {}
    for skill, p in params.items():
        out[skill] = {
            "probMastery": p.get("prior", DEFAULT_PRIOR),
            "probTransit": p.get("learns", DEFAULT_LEARNS),
            "probSlip": p.get("slips", DEFAULT_SLIPS),
            "probGuess": p.get("guesses", DEFAULT_GUESSES),
        }
    return {"ok": True, "value": {"parameters": out}, "parameter_set_id": req.get("parameter_set_id", "bkt_cal_auto")}


def op_predict(req: dict) -> dict:
    """按拟合模型预测逐行 p_correct / p_mastery（calibrated 阶段）。"""
    from pyBKT.models import Model

    rows = req.get("rows") or []
    if not rows:
        return {"ok": False, "error": "invalid_request", "detail": "rows 必填"}
    df = pd.DataFrame([{
        "order_id": idx, "skill_name": r["dimension_id"],
        "correct": 1 if r["outcome"] == "success" else 0, "user_id": r["student_id"],
    } for idx, r in enumerate(rows)])
    model = Model(seed=1)
    model.fit(data=df, skills=sorted(df["skill_name"].unique()), num_fits=3)
    pred = model.predict(data=df)
    predictions = []
    for (_, row), orig in zip(pred.iterrows(), rows):
        predictions.append({
            "student_id": orig["student_id"], "dimension_id": orig["dimension_id"],
            "p_correct": float(row["correct_predictions"]), "p_mastery": float(row["state_predictions"]),
        })
    return {"ok": True, "value": {"predictions": predictions}}


def main() -> int:
    store = RosterStore({
        "probMastery": DEFAULT_PRIOR, "probTransit": DEFAULT_LEARNS,
        "probSlip": DEFAULT_SLIPS, "probGuess": DEFAULT_GUESSES,
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "roster_update":
                out = op_roster_update(store, req)
            elif op == "roster_get":
                out = op_roster_get(store, req)
            elif op == "fit":
                out = op_fit(req)
            elif op == "predict":
                out = op_predict(req)
            else:
                out = {"ok": False, "error": f"unknown op: {op}"}
        except Exception as err:  # 侧车失败显式报错，不伪造结果
            out = {"ok": False, "error": "sidecar_error", "detail": str(err)}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
