/**
 * group-next 渲染内核：把一份结构化试卷（标题 + 若干题）渲染成 LaTeX，再用
 * XeLaTeX + ctex（fontset=noto）编译为 PDF。题干是带 Unicode 数学符号的纯文本
 * （项目内无 $...$ 内联数学标记），因此做法是：保留 Unicode 由 CJK 字体排版，
 * 只对会破坏 LaTeX 的 ASCII 元字符与本应进入行内数学的几个符号做最小转义。
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TYPE_LABEL: Record<string, string> = {
  single_choice: "一二、选择题",
  multiple_choice: "一二、选择题",
  fill_blank: "二三、填空题",
  true_false: "一二、判断题",
  open_solution: "三四、解答题",
};

export interface RenderOption {
  option_key: string;
  option_text: string;
}

export interface RenderItem {
  stem_format: string;
  stem_markdown: string;
  difficulty: number | null;
  options: RenderOption[];
}

export interface RenderPaper {
  title: string;
  items: RenderItem[];
}

export interface RenderAnswerItem {
  item_order: number;
  stem_format: string;
  stem_markdown: string;
  options: RenderOption[];
  answer_text: string;
  analysis_text: string;
}

export interface RenderAnswerPaper {
  title: string;
  items: RenderAnswerItem[];
}

const MATH_CASUAL: Array<[RegExp, string]> = [
  [/[≤⩽]/gu, "\\ensuremath{\\le}"],
  [/[≥⩾]/gu, "\\ensuremath{\\ge}"],
  [/[≠≠]/gu, "\\ensuremath{\\neq}"],
];

function texEscapeText(value: string): string {
  // 题干是 markdown 混排：$...$ 内已是合法 LaTeX 行内数学，原样透传；
  // 其余纯文本段只做最小转义（ASCII 元字符 + 少量 Unicode 数学符号）。
  return value.split(/(\$[^$\n]*\$)/g).map((part) => {
    if (part.length > 1 && part.startsWith("$") && part.endsWith("$")) return part;
    let out = part.replace(/([\\{}&#%_^~])/g, (ch) => {
      switch (ch) {
        case "\\": return "\\textbackslash{}";
        case "{": return "\\{";
        case "}": return "\\}";
        case "&": return "\\&";
        case "#": return "\\#";
        case "%": return "\\%";
        case "_": return "\\_";
        case "^": return "\\^{}";
        default: return "\\textasciitilde{}";
      }
    });
    // < > 在文本模式下会排成倒引号，改用行内数学正确显示。
    out = out.replace(/[<>]/g, (ch) => `\\ensuremath{${ch}}`);
    for (const [re, replacement] of MATH_CASUAL) out = out.replace(re, replacement);
    return out;
  }).join("");
}

function texParagraph(text: string): string {
  const escaped = texEscapeText(text ?? "");
  const paragraphs = escaped.split(/\n{2,}/).map((part) => part.replace(/\n/g, " ")).filter((part) => part.trim().length > 0);
  return paragraphs.length === 0 ? "" : paragraphs.map((part) => `\n${part}`).join("\n\n");
}

function renderItem(item: RenderItem, index: number): string {
  const number = index + 1;
  const stem = texParagraph(item.stem_markdown || "（题目内容）");
  const options = (item.options ?? []).slice(0, 5);
  const optionLines = options
    .map((option) => `\\hspace*{2em}${texEscapeText(String(option.option_key))}．${texParagraph(option.option_text || "")}`)
    .join("\n");
  const answerSpace = item.stem_format === "fill_blank" ? "\n\n\\vspace{18pt}" : item.stem_format === "open_solution" ? "\n\n\\vspace{40pt}" : "";
  return [
    "",
    `\\noindent\\textbf{${number}．}\\hspace{1em}${stem.trim()}`,
    options.length > 0 ? optionLines : "",
    answerSpace,
    "\\vspace{10pt}",
  ].filter((part) => part.length > 0).join("\n");
}

export function buildTex(paper: RenderPaper): string {
  const title = texEscapeText(paper.title.trim() || "数学试卷");
  const total = paper.items.length;
  const body = paper.items
    .map((item, index) => renderItem(item, index))
    .join("\n");
  return `\\documentclass[12pt]{ctexart}
\\usepackage[fontset=noto]{ctex}
\\usepackage[a4paper,top=2.2cm,bottom=2.4cm,left=2.4cm,right=2.4cm]{geometry}
\\usepackage{amsmath,amssymb}
\\pagestyle{plain}
\\setlength{\\parindent}{0pt}
\\begin{document}
\\begin{center}
{\\LARGE\\bfseries ${title}}\\\\[6pt]
{\\small 数学智元 MathPilot · 共 ${total} 题}\\\\[4pt]
\\dotfill
\\end{center}
\\vspace{14pt}
${body}
\\end{document}
`;
}

/**
 * 编译：两次 XeLaTeX 保证版面稳定。目录、文件名均用 ASCII，规避 CJK 文件名问题。
 */
export async function renderPaperToPdf(paper: RenderPaper): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "mathpilot-group-"));
  const texPath = join(dir, "paper.tex");
  try {
    await writeFile(texPath, buildTex(paper), "utf8");
    for (let round = 0; round < 2; round += 1) {
      await execFileP(
        "xelatex",
        ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", texPath],
        { cwd: dir, timeout: 150_000, maxBuffer: 16 * 1024 * 1024 },
      );
    }
    return await readFile(join(dir, "paper.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- 答案解析渲染（速查表 + 逐题【答案】【解析】） ----

const ANSWER_SECTION_ORDER = ["single_choice", "multiple_choice", "fill_blank", "true_false", "open_solution"] as const;
const ANSWER_SECTION_LABEL: Record<string, string> = {
  single_choice: "单项选择题",
  multiple_choice: "多项选择题",
  fill_blank: "填空题",
  true_false: "判断题",
  open_solution: "解答题",
};
const CN_NUM = ["一", "二", "三", "四", "五"];

function buildAnswerTable(choiceItems: RenderAnswerItem[]): string {
  const chunks: RenderAnswerItem[][] = [];
  for (let i = 0; i < choiceItems.length; i += 10) chunks.push(choiceItems.slice(i, i + 10));
  return chunks.map((chunk) => {
    const numbers = chunk.map((item) => String(item.item_order + 1)).join(" & ");
    const answers = chunk.map((item) => texEscapeText(item.answer_text || "待定")).join(" & ");
    const cols = `|c${"|c".repeat(chunk.length)}|`;
    return `\\begin{tabular}{${cols}}\n\\hline\n题号 & ${numbers} \\\\\n\\hline\n答案 & ${answers} \\\\\n\\hline\n\\end{tabular}`;
  }).join("\n\n");
}

function renderAnswerItem(item: RenderAnswerItem, number: number): string {
  const stem = texParagraph(item.stem_markdown || "（题目内容）");
  const optionLines = (item.options ?? []).slice(0, 5)
    .map((option) => `\\hspace*{2em}${texEscapeText(String(option.option_key))}．${texParagraph(option.option_text || "")}`)
    .join("\n");
  const answer = texParagraph(item.answer_text || "待人工核对");
  const analysis = texParagraph(item.analysis_text || "（解析待补充）");
  return [
    "",
    `\\noindent\\textbf{${number}．}\\hspace{1em}${stem.trim()}`,
    optionLines.length > 0 ? optionLines : "",
    `\\textbf{【答案】}${answer}`,
    `\\textbf{【解析】}${analysis}`,
    "\\vspace{12pt}",
  ].filter((part) => part.length > 0).join("\n");
}

export function buildAnswerTex(paper: RenderAnswerPaper): string {
  const title = texEscapeText(paper.title.trim() || "数学试卷");
  const items = [...paper.items].sort((a, b) => a.item_order - b.item_order);
  const choiceItems = items.filter((item) => item.stem_format === "single_choice" || item.stem_format === "multiple_choice");
  const sections = ANSWER_SECTION_ORDER
    .map((format) => ({ format, rows: items.filter((item) => item.stem_format === format) }))
    .filter((section) => section.rows.length > 0)
    .map((section, index) => {
      const heading = `${CN_NUM[index] ?? String(index + 1)}、${ANSWER_SECTION_LABEL[section.format] ?? section.format}`;
      const body = section.rows.map((item) => renderAnswerItem(item, item.item_order + 1)).join("\n");
      return `\\begin{center}{\\heiti\\large ${heading}}\\end{center}\n${body}`;
    })
    .join("\n\n");
  const answerTable = choiceItems.length > 0
    ? `{\\centering\\heiti 选择题答案速查表\\par}\\vspace{3pt}\n\\begin{center}\n${buildAnswerTable(choiceItems)}\n\\end{center}\n\\vspace{10pt}`
    : "";
  return `\\documentclass[12pt]{ctexart}
\\usepackage[fontset=noto]{ctex}
\\usepackage[a4paper,top=2.2cm,bottom=2.4cm,left=2.4cm,right=2.4cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{xcolor}
\\pagestyle{plain}
\\setlength{\\parindent}{0pt}
\\begin{document}
\\begin{center}
{\\LARGE\\bfseries ${title}参考答案与解析}\\\\[6pt]
{\\small 数学智元 MathPilot · 共 ${items.length} 题}\\\\[4pt]
\\dotfill
\\end{center}
\\vspace{14pt}
${answerTable}
${sections}
\\end{document}
`;
}

export async function renderAnswerToPdf(paper: RenderAnswerPaper): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "mathpilot-group-answer-"));
  const texPath = join(dir, "answer.tex");
  try {
    await writeFile(texPath, buildAnswerTex(paper), "utf8");
    for (let round = 0; round < 2; round += 1) {
      await execFileP(
        "xelatex",
        ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", texPath],
        { cwd: dir, timeout: 150_000, maxBuffer: 16 * 1024 * 1024 },
      );
    }
    return await readFile(join(dir, "answer.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}