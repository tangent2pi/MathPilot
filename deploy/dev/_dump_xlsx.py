import openpyxl, json, re
path = r"D:/git/mathpilot/MathPilot_next/data/knowledge-bank/解三角形/数学知识库_解三角形_完整版.xlsx"
wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
ws = wb["题库样本"]
rows = ws.iter_rows(values_only=True)
header = [str(h).strip() if h else "" for h in next(rows)]
idx = {h: i for i, h in enumerate(header)}

def clean(v): return (str(v).strip() if v is not None else "")

def classify(ans):
    ans = clean(ans)
    if re.search(r'\(1\)|\(2\)|\(3\)|\(4\)', ans): return "open_solution"
    if re.search(r'证明|见解析|选[①②③]|无解|不存在|当[αθβγ]', ans): return "open_solution"
    if re.fullmatch(r'[A-DＡ-Ｄ]{2,}', ans): return "multiple_choice"
    if re.fullmatch(r'[A-DＡ-Ｄ]', ans): return "single_choice"
    if re.search(r'[，；]|最大值|最小值|及', ans): return "open_solution"
    return "fill_blank"

os_list = []
for r in rows:
    if any(v is not None and str(v).strip() != "" for v in r):
        qid = clean(r[idx["题目ID"]])
        ans = clean(r[idx["答案"]])
        if classify(ans) == "open_solution":
            os_list.append((qid, ans))

print(f"open_solution 共 {len(os_list)} 题：")
for qid, ans in os_list:
    print(f"  {qid}: {ans}")
