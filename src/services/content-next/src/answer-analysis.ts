/**
 * 组卷答案 AI 补全：调用 OpenAI 兼容的 chat completions（DeepSeek）。
 * 仅对题库缺失的解析/答案做补全；题库已有内容原样保留。模型结论与题库
 * 答案冲突时标记 need_review，交由教师在线复核裁定（绝不静默二选一）。
 */

import { casualToLatex } from "./math-latex";

type Json = Record<string, unknown>;

export interface QuestionForAnalysis {
  item_order: number;
  stem_format: string;
  stem_markdown: string;
  options: Array<{ option_key: string; option_text: string }>;
  answer_text: string;
  analysis_text: string;
}

export interface CompletedAnalysis {
  item_order: number;
  answer_text: string;
  analysis_text: string;
  need_review: boolean;
  review_note: string | null;
  source: "bank" | "ai";
}

const TYPE_LABEL: Record<string, string> = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  fill_blank: "填空题",
  true_false: "判断题",
  open_solution: "解答题",
};

/** 把题库 answer_text 归一化为纯文本：兼容 JSON（correct_keys/answer）与纯文本两种存储。 */
export function normalizeBankAnswer(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (Array.isArray(row.correct_keys)) {
        return row.correct_keys.filter((key): key is string => typeof key === "string").join("");
      }
      if (typeof row.answer === "string") return row.answer.trim();
    }
  } catch { /* 非 JSON 则原样返回 */ }
  return trimmed;
}

/**
 * 单/多选答案归一为选项字母：内容是选项文本/数值时，映射为唯一命中的选项 key；
 * 已是纯字母则原样返回；无法唯一命中时**原样返回、不做猜测**（铁律⑳：渲染层只排版）。
 */
export function ensureChoiceLetterAnswer(
  stemFormat: string,
  options: Array<{ option_key: string; option_text: string }>,
  value: string,
): string {
  const v = value.trim();
  if (stemFormat !== "single_choice" && stemFormat !== "multiple_choice") return v;
  // 选择判断题答案应是字母/短数值，去掉尾部装饰性标点再判；解答题等不在此分支，不受影响。
  const vc = v.replace(/[。．,.；;]+$/u, "").trim() || v;
  if (vc.length > 0 && vc.length <= 8 && /^[A-Ha-h]+$/.test(vc)) return vc.toUpperCase();
  if (!options.length) return v;
  const stripPrefix = (text: string) => text.replace(/^\s*[A-Ha-h]\s*[．.)、:：]/u, "").replace(/[。．,.；;\s]+$/u, "").trim();
  const bodies = options.map((option) => ({
    key: option.option_key.trim().toUpperCase(),
    body: stripPrefix(option.option_text),
  }));
  // 仅当答案与某选项文本"相等"，或答案作为完整表达式（长度≥2）唯一出现在某个选项里时才映射；
  // 短数值（如 "7" ⊂ "√7"）会被误判，一律不猜，防止给出未经核实的选项。
  const matched = bodies.filter((option) => {
    if (option.body === "") return false;
    return option.body === vc || (option.body.includes(vc) && vc.length >= 2);
  });
  if (matched.length === 1) return matched[0]!.key;
  if (stemFormat === "multiple_choice" && matched.length > 1) {
    return matched.map((option) => option.key).join("");
  }
  return v;
}

function modelSettings(): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = process.env.MODEL_API_BASE?.trim();
  const apiKey = process.env.MODEL_API_KEY?.trim();
  const model = process.env.MODEL_ID_MAIN?.trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error("MODEL_API_BASE / MODEL_API_KEY / MODEL_ID_MAIN are required for AI answer completion");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

function buildPrompt(question: QuestionForAnalysis): string {
  const typeLabel = TYPE_LABEL[question.stem_format] ?? "题目";
  const optionLines = question.options.length > 0
    ? `\n选项：\n${question.options.map((o) => `${o.option_key}. ${o.option_text}`).join("\n")}`
    : "";
  const bankAnswer = question.answer_text.trim()
    ? `\n题库给出的标准答案：${question.answer_text.trim()}`
    : "\n题库未给出答案，请自行推导。";
  return `你是高中数学教师，为下面这道${typeLabel}撰写标准答案与完整解析。

题干：${question.stem_markdown}${optionLines}${bankAnswer}

要求：
1. 输出 JSON 对象，字段：
   - "answer": 标准答案。选择题写正确选项字母（多选写全部正确字母，如 "ABD"）；填空题/解答题写最终结果。
   - "analysis": 完整解析。单选题给出完整推导步骤并以"故选 X"结尾；多选题逐个选项分析正确依据或错误原因，最后"综上，选 XX"；解答题给出完整推导步骤。
   - "need_review": 布尔值。仅当题库答案与严谨推导结论冲突（如端点开闭、选项多/漏选、题面数据自相矛盾）时为 true，否则 false。
   - "review_note": need_review 为 true 时写清"题库原答案 X、严谨结论 Y、分歧原因"；否则为 null。
2. 数学符号用纯文本（如 √3、π/3、45°、△ABC），不要用 LaTeX 命令。
3. 只输出 JSON，不要输出其它文字。`;
}

function parseModelJson(text: string): Json {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model returned no JSON object");
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("model returned a non-object JSON");
  return parsed as Json;
}

async function callModel(prompt: string, signal?: AbortSignal): Promise<string> {
  const { baseUrl, apiKey, model } = modelSettings();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "你是严谨的高中数学教师，只输出符合要求的 JSON。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          // 推理模型会把大量 token 花在 reasoning_content 上；预算不足会导致 content 为空。
          max_tokens: 8000,
          response_format: { type: "json_object" },
        }),
        ...(signal ? { signal } : {}),
        redirect: "error",
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`model api returned ${response.status}: ${detail.slice(0, 300)}`);
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (content && content.trim().length > 0) return content;
      lastError = new Error("model api returned empty content");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (signal?.aborted) throw lastError;
    }
  }
  throw lastError ?? new Error("model api call failed");
}

/** 补全单题缺失的解析/答案。题库已有内容原样保留。 */
export async function completeQuestionAnalysis(
  question: QuestionForAnalysis,
  signal?: AbortSignal,
): Promise<CompletedAnalysis> {
  const bankAnswer = question.answer_text.trim();
  const bankAnalysis = question.analysis_text.trim();
  if (bankAnswer && bankAnalysis) {
    return {
      item_order: question.item_order,
      answer_text: casualToLatex(bankAnswer),
      analysis_text: casualToLatex(bankAnalysis),
      need_review: false,
      review_note: null,
      source: "bank",
    };
  }
  const content = await callModel(buildPrompt(question), signal);
  const parsed = parseModelJson(content);
  const aiAnswer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const aiAnalysis = typeof parsed.analysis === "string" ? parsed.analysis.trim() : "";
  const needReview = parsed.need_review === true;
  const reviewNote = typeof parsed.review_note === "string" && parsed.review_note.trim() ? parsed.review_note.trim() : null;
  if (!aiAnswer && !aiAnalysis) throw new Error("model returned empty answer and analysis");
  return {
    item_order: question.item_order,
    // 题库有答案则保留题库答案；只有题库缺答案时才采用模型答案。
    answer_text: casualToLatex(ensureChoiceLetterAnswer(question.stem_format, question.options, bankAnswer || aiAnswer)),
    analysis_text: casualToLatex(bankAnalysis || aiAnalysis),
    need_review: needReview && Boolean(bankAnswer),
    review_note: needReview && Boolean(bankAnswer) ? reviewNote : null,
    source: bankAnalysis ? "bank" : "ai",
  };
}

/** 并发补全多题缺失解析，单题失败不阻断整卷（返回失败项供上层标注）。 */
export async function completeMissingAnalyses(
  questions: QuestionForAnalysis[],
  concurrency = 3,
): Promise<{ completed: CompletedAnalysis[]; failed: number[] }> {
  const completed: CompletedAnalysis[] = [];
  const failed: number[] = [];
  const queue = [...questions];
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
    while (queue.length > 0) {
      const question = queue.shift()!;
      try {
        completed.push(await completeQuestionAnalysis(question));
      } catch (error) {
        failed.push(question.item_order);
        console.error(`[answer-analysis] item ${question.item_order} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  await Promise.all(workers);
  completed.sort((a, b) => a.item_order - b.item_order);
  return { completed, failed };
}
