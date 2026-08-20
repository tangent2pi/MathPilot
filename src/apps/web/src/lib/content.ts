export const stemFormatLabel: Record<string, string> = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  fill_blank: "填空题",
  true_false: "判断题",
  open_solution: "解答题",
};

export const reviewTypeLabel: Record<string, string> = {
  question: "题目",
  knowledge_component: "知识点",
  question_type: "题型",
  error_cause: "错因",
  diagnosis_rule: "诊断规则",
};

export const reviewStatusLabel: Record<string, string> = {
  pending: "待复核",
  confirmed: "已确认",
  modified: "修改后确认",
  rejected: "已退回",
  merged: "已合并",
};

export function optionLabel(index: number, key?: string): string {
  return key?.trim().toUpperCase() || String.fromCharCode(65 + index);
}

export function formatAnswer(value: unknown): string {
  if (value == null || value === "") return "暂未提供";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "正确" : "错误";
  if (Array.isArray(value)) return value.map(formatAnswer).join("、");
  if (typeof value === "object") {
    const answer = value as Record<string, unknown>;
    if (Array.isArray(answer.choices)) return answer.choices.map(String).join("、");
    if (typeof answer.choice === "string") return answer.choice;
    if (Array.isArray(answer.values)) return answer.values.map(String).join("、");
    if (typeof answer.value === "string" || typeof answer.value === "number") return String(answer.value);
    if (typeof answer.boolean === "boolean") return answer.boolean ? "正确" : "错误";
    if (typeof answer.summary === "string" && answer.summary.trim()) return answer.summary;
  }
  return "查看详细答案说明";
}

export function candidateTitle(candidate: Record<string, unknown>, targetId: string): string {
  return String(candidate.stem_markdown || candidate.name || candidate.trigger || candidate.probe || targetId);
}
