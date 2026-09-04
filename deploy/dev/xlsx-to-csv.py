#!/usr/bin/env python3
"""
把文件库 xlsx（解三角形 完整版）转成 migrate-official-content.ts 期望的 CSV。

- 知识点 K_TRI_001~049（保留 ID）
- 题型   T_TRI_001~036（保留 ID）
- 题目   Q_TRI_001~139 → 重编号 Q_TRI_301~439（+300 偏移，避开 DB 既有 Q_TRI_001~020 官方种子 / Q_TRI_003~139 旧残次导入 / Q_TRI_201~216 试点）
- 错因   E-XXX-NNN（73 条，保留 ID）

难度保留 1-5（导入器侧 numberDifficulty 映射 n/5）。
题目题型(stem_format)由「答案 + 题干」推断：单选/多选/填空/解答(open_solution)。
选择题题干内嵌 A.…B.…C.…D.… 选项会拆到「选项」列。
"""
import csv, hashlib, json, os, re, sys
import openpyxl

XLSX = r"D:/git/mathpilot/MathPilot_next/data/knowledge-bank/解三角形/数学知识库_解三角形_完整版.xlsx"
OUT_DIR = r"D:/git/mathpilot/MathPilot_next/data/official-content/triangle-kb"
MANIFEST = r"D:/git/mathpilot/MathPilot_next/db/migration-data/kb-triangle-manifest.csv"

Q_OFFSET = 300  # Q_TRI_001 → Q_TRI_301

OPTION_RE = re.compile(r'([A-DＡ-Ｄ])\s*[.、．]\s*')


def load_sheet(name):
    ws = wb[name]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h else "" for h in next(rows)]
    data = []
    for r in rows:
        if any(v is not None and str(v).strip() != "" for v in r):
            data.append({header[i]: (v if v is not None else "") for i, v in enumerate(r)})
    return header, data


def clean(v):
    if v is None:
        return ""
    s = str(v).strip()
    return s


def pipe_ids(v):
    """把 ID 列表的分隔符统一成 migrate 期望的 |（兼容 ; 与 ；）。"""
    return clean(v).replace("；", "|").replace(";", "|")


def renumber_qid(qid):
    m = re.fullmatch(r'Q_TRI_(\d+)', qid)
    if not m:
        return qid
    return f"Q_TRI_{int(m.group(1)) + Q_OFFSET}"


def extract_options(stem):
    """返回 (题干, 选项字符串 or None)。题干去掉了内嵌选项。"""
    s = stem
    m = re.search(r'[（(]\s*[）)]', s)
    q = s
    opts_raw = ""
    if m:
        q = s[:m.start()].strip()
        opts_raw = s[m.end():].strip()
    else:
        m2 = re.search(r'[A-DＡ-Ｄ]\s*[.、．]', s)
        if m2:
            q = s[:m2.start()].strip()
            opts_raw = s[m2.start():]
    if not opts_raw:
        return s.strip(), None
    matches = list(re.finditer(r'([A-DＡ-Ｄ])\s*[.、．]\s*', opts_raw))
    if not matches:
        return s.strip(), None
    opts = []
    for j, mm in enumerate(matches):
        key = mm.group(1)
        end = matches[j + 1].start() if j + 1 < len(matches) else len(opts_raw)
        text = opts_raw[mm.end():end].strip()
        opts.append(f"{key}.{text}")
    # 题干末尾保留占位符，选择题用（ ），填空题维持原样
    q = q.strip()
    if not q.endswith("（ ）") and not q.endswith("()"):
        q = q + "（ ）"
    return q, "|".join(opts)


def classify(answer, stem):
    """返回 (stem_format, 题型中文)。stem_format 供导入器；题型中文供 migrate stemFormat() 识别。"""
    ans = clean(answer)
    # 多小问
    if re.search(r'\(1\)|\(2\)|\(3\)|\(4\)', ans):
        return "open_solution", "解答题"
    # 证明 / 开放 / 条件选择
    if re.search(r'证明|见解析|选[①②③]|无解|不存在|当[αθβγ]', ans):
        return "open_solution", "解答题"
    # 多选（答案两个及以上字母）
    if re.fullmatch(r'[A-DＡ-Ｄ]{2,}', ans):
        return "multiple_choice", "多选题"
    # 单选（答案单个字母）
    if re.fullmatch(r'[A-DＡ-Ｄ]', ans):
        return "single_choice", "选择题"
    # 多值填空（中文逗号/分号、最大值/最小值+及 等）→ 无法可靠自动判，归解答
    if re.search(r'[，；]|最大值|最小值|及', ans):
        return "open_solution", "解答题"
    # 其余单值填空
    return "fill_blank", "填空题"


wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)

os.makedirs(OUT_DIR, exist_ok=True)

# ---- 知识点 ----
_, kp_rows = load_sheet("知识点库")
kp_out = []
for d in kp_rows:
    pre = pipe_ids(d.get("前置知识点ID", ""))
    if pre in ("无（基础起点）", "无", "无(基础起点)", "基础起点"):
        pre = ""
    kp_out.append({
        "knowledge_id": clean(d.get("知识点ID", "")),
        "一级模块": clean(d.get("一级模块", "")),
        "二级模块": clean(d.get("二级模块", "")),
        "三级模块": clean(d.get("三级模块", "")),
        "知识点名称": clean(d.get("知识点名称", "")),
        "难度": clean(d.get("难度", "")),
        "前置知识点": pre,
        "掌握标准": clean(d.get("掌握标准", "")),
        "补弱建议": clean(d.get("补弱建议", "")),
    })

# ---- 题型 ----
_, qt_rows = load_sheet("题型库")
qt_out = []
for d in qt_rows:
    qt_out.append({
        "type_id": clean(d.get("题型ID", "")),
        "题型名称": clean(d.get("题型名称", "")),
        "关联知识点": pipe_ids(d.get("关联知识点ID", "")),
        "典型问法": clean(d.get("识别特征/典型问法", "")),
        "标准步骤": clean(d.get("标准解题步骤", "")),
        "评分点": clean(d.get("评分点", "")),
        "训练顺序": clean(d.get("训练顺序", "")),
    })

# ---- 错因 ----
_, ec_rows = load_sheet("错因库")
ec_out = []
for d in ec_rows:
    ec_out.append({
        "error_id": clean(d.get("错因ID", "")),
        "错因大类": clean(d.get("错因大类", "")),
        "错因名称": clean(d.get("错因名称", "")),
        "表现形式": clean(d.get("表现形式", "")),
        "判断依据": clean(d.get("判断依据", "")),
        "补救建议": clean(d.get("补救建议", "")),
    })

# ---- 题目 ----
_, q_rows = load_sheet("题库样本")
q_out = []
stats = {"single_choice": 0, "multiple_choice": 0, "fill_blank": 0, "open_solution": 0}
warn = []
for d in q_rows:
    qid = clean(d.get("题目ID", ""))
    new_qid = renumber_qid(qid)
    answer = clean(d.get("答案", ""))
    stem = clean(d.get("题干", ""))
    fmt, cn_type = classify(answer, stem)
    options = None
    if fmt in ("single_choice", "multiple_choice"):
        stem, options = extract_options(stem)
        if options is None:
            warn.append(f"{new_qid}: 判定为{cn_type}但未找到选项，回退 open_solution")
            fmt, cn_type = "open_solution", "解答题"
    stats[fmt] += 1
    q_out.append({
        "question_id": new_qid,
        "来源": clean(d.get("题目来源", "")),
        "题型": cn_type,
        "题干": stem,
        "选项": options or "",
        "答案": answer,
        "解析": clean(d.get("解析", "")),
        "知识点ID": pipe_ids(d.get("知识点ID", "")),
        "题型ID": pipe_ids(d.get("题型ID", "")),
        "常见错因ID": pipe_ids(d.get("常见错因ID", "")),
        "难度": clean(d.get("难度", "")),
    })

# ---- 写出 CSV ----
def write_csv(name, header, rows):
    path = os.path.join(OUT_DIR, name)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in header})
    return path

files = {
    "knowledge_points.csv": ("knowledge", "knowledge_id", ["knowledge_id", "一级模块", "二级模块", "三级模块", "知识点名称", "难度", "前置知识点", "掌握标准", "补弱建议"], kp_out),
    "question_types.csv": ("question_type", "type_id", ["type_id", "题型名称", "关联知识点", "典型问法", "标准步骤", "评分点", "训练顺序"], qt_out),
    "questions.csv": ("question", "question_id", ["question_id", "来源", "题型", "题干", "选项", "答案", "解析", "知识点ID", "题型ID", "常见错因ID", "难度"], q_out),
    "error_causes.csv": ("error_cause", "error_id", ["error_id", "错因大类", "错因名称", "表现形式", "判断依据", "补救建议"], ec_out),
}

manifest_rows = []
for name, (kind, id_col, header, rows) in files.items():
    p = write_csv(name, header, rows)
    raw = open(p, "rb").read()
    sha = hashlib.sha256(raw).hexdigest()
    rel = f"data/official-content/triangle-kb/{name}"
    manifest_rows.append({
        "source_file": rel,
        "entity_kind": kind,
        "id_column": id_col,
        "row_count": len(rows),
        "sha256": sha,
        "origin": "official",
        "owner_user_id": "",
    })

with open(MANIFEST, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["source_file", "entity_kind", "id_column", "row_count", "sha256", "origin", "owner_user_id"])
    w.writeheader()
    for r in manifest_rows:
        w.writerow(r)

# ---- 报告 ----
print("=== 转换统计 ===")
print(f"知识点: {len(kp_out)}  题型: {len(qt_out)}  题目: {len(q_out)}  错因: {len(ec_out)}")
print(f"stem_format 分布: {json.dumps(stats, ensure_ascii=False)}")
if warn:
    print("=== 警告（回退 open_solution）===")
    for w in warn:
        print(" ", w)

# 难度 × 模块 交叉（用于验证 8/5/2 配比）
mod_bucket = {}
for r in q_out:
    # 题目来源里有"一、入门题型"等，从题型库映射更准；这里用知识点归属的二级模块过于复杂，
    # 直接按题目难度统计即可，模块维度由 knowledge 二级模块在 DB 侧判定。
    pass
print("manifest ->", MANIFEST)
