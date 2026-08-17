# sidecars/pybkt — BKT 算法侧车（ADR-001）

pyBKT 成品包装：批量校准（fit/predict）与逐学生×逐维度掌握度（Roster）。
Python 进程不直接读写 PostgreSQL；经 stdin JSON-lines → stdout JSON 由 TS 宿主调用。

## 环境与安装

```sh
nix develop -c bash sidecars/pybkt/setup.sh   # 创建 .venv 并安装 pyBKT（sklearn<1.6 兼容钉版）
```

运行（侧车调用方）：

```sh
echo '{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_1"}' \
  | .venv/bin/python sidecars/pybkt/cli.py
```

## 操作契约

| op | 请求 | 响应 |
|---|---|---|
| `roster_update` | student_id, dimension_id, outcome(success\|failure), order_id | `{p_mastery}` + parameter_set_id |
| `roster_get` | student_id, dimension_id | `{p_mastery}`（无观测 → null + note） |
| `fit` | parameter_set_id, rows[] | `{parameters: {dim: {probMastery,probTransit,probSlip,probGuess}}}` |
| `predict` | rows[] | `{predictions: [{p_correct, p_mastery}]}` |

## 状态与确定性

- 状态 = `state/observations.jsonl`（纯文件，无隐藏状态；重放即确定性）；
- 先验参数集（bkt_prior_v1）经手工构造 fit_model 注入（pyBKT 本版 fixed 参数路径有
  C++ 兼容 bug，见 roster.py 注释；构造与 fit 产物同构，Roster/State 走同一 _predict）；
- **数学对拍**：pyBKT Roster 与 packages/mastery（OATutor 移植 TS 引擎）同观测序列
  掌握度差异 = 0.0（侧车契约测试覆盖）；
- calibrated 阶段：`fit` 全量 EM 拟合产出参数集，`predict` 逐行预测。

## 测试

```sh
nix develop -c bash sidecars/pybkt/test.sh
```
