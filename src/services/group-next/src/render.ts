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
  item_order: number;
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
  [/△/gu, "\\ensuremath{\\triangle}"],
  [/π/gu, "\\ensuremath{\\pi}"],
  [/°/gu, "\\ensuremath{{}^{\\circ}}"],
  [/×/gu, "\\ensuremath{\\times}"],
  [/÷/gu, "\\ensuremath{\\div}"],
  [/±/gu, "\\ensuremath{\\pm}"],
  [/∈/gu, "\\ensuremath{\\in}"],
  [/∉/gu, "\\ensuremath{\\notin}"],
  [/∪/gu, "\\ensuremath{\\cup}"],
  [/∩/gu, "\\ensuremath{\\cap}"],
  [/⊂/gu, "\\ensuremath{\\subset}"],
  [/⊆/gu, "\\ensuremath{\\subseteq}"],
  [/∞/gu, "\\ensuremath{\\infty}"],
  [/∠/gu, "\\ensuremath{\\angle}"],
  [/⊥/gu, "\\ensuremath{\\perp}"],
  [/∥/gu, "\\ensuremath{\\parallel}"],
  [/⇒/gu, "\\ensuremath{\\Rightarrow}"],
  [/⇔/gu, "\\ensuremath{\\Leftrightarrow}"],
  [/→/gu, "\\ensuremath{\\to}"],
  [/∝/gu, "\\ensuremath{\\propto}"],
  [/≈/gu, "\\ensuremath{\\approx}"],
  [/≡/gu, "\\ensuremath{\\equiv}"],
  [/∀/gu, "\\ensuremath{\\forall}"],
  [/∃/gu, "\\ensuremath{\\exists}"],
  [/α/gu, "\\ensuremath{\\alpha}"],
  [/β/gu, "\\ensuremath{\\beta}"],
  [/γ/gu, "\\ensuremath{\\gamma}"],
  [/δ/gu, "\\ensuremath{\\delta}"],
  [/θ/gu, "\\ensuremath{\\theta}"],
  [/λ/gu, "\\ensuremath{\\lambda}"],
  [/μ/gu, "\\ensuremath{\\mu}"],
  [/φ/gu, "\\ensuremath{\\varphi}"],
  [/ω/gu, "\\ensuremath{\\omega}"],
];

const SUPERSCRIPT: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-" };

function texEscapeText(value: string): string {
  // 题干是 markdown 混排：$...$ 内已是合法 LaTeX 行内数学，原样透传
  // 并统一分数为 \dfrac（skill：全尺寸分数，不打半角缩小）；其余纯文本段
  // 只做最小转义（ASCII 元字符 + 少量 Unicode 数学符号）。
  return value.split(/(\$[^$\n]*\$)/g).map((part) => {
    if (part.length > 1 && part.startsWith("$") && part.endsWith("$")) {
      return part.replace(/\\frac/g, "\\dfrac");
    }
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
    // 上标字符 → ^{n}
    out = out.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/gu, (ch) => `\\ensuremath{^{${SUPERSCRIPT[ch] ?? ch}}}`);
    // √(表达式) 或 √数字 → \sqrt{...}
    out = out.replace(/√\s*[(\[]([^)\]]*)[)\]]/g, (_m, g) => `\\ensuremath{\\sqrt{${g.trim()}}}`);
    out = out.replace(/√([0-9.]+)/g, (_m, g) => `\\ensuremath{\\sqrt{${g}}}`);
    return out;
  }).join("");
}

function texParagraph(text: string): string {
  const escaped = texEscapeText(text ?? "");
  const paragraphs = escaped.split(/\n{2,}/).map((part) => part.replace(/\n/g, " ")).filter((part) => part.trim().length > 0);
  return paragraphs.length === 0 ? "" : paragraphs.map((part) => `\n${part}`).join("\n\n");
}

/** 题干悬挂缩进量：9 题内 1.5em，10 题起 2em（skill 规范）。 */
function hangingIndent(number: number): string {
  return number <= 9 ? "1.5em" : "2em";
}

/** 统计解答题子问 (1)(2)(3)… 数量，用于作答留白（skill：count_sub 先整段拼接再匹配）。 */
function countSubquestions(stem: string): number {
  const flat = (stem ?? "").replace(/\s+/g, "");
  const m = flat.match(/[(（]\d+[)）]/g);
  const nums = (m ?? []).map((s) => parseInt(s.replace(/[^\d]/g, ""), 10)).filter((n) => Number.isFinite(n));
  return nums.length > 0 ? Math.max(...nums) : 0;
}

/** 解答题作答留白：2.5cm 基 + 每多一小问 0.4cm，封顶 3.2cm（skill 实测公式）。 */
function solutionSpace(sub: number): string {
  if (sub <= 1) return "2.5cm";
  return `${Math.min(2.5 + 0.4 * (sub - 1), 3.2).toFixed(2)}cm`;
}

/**
 * 选项块：skill 决策树。先 \settowidth 测最宽选项，再按宽分段：
 * 超 17.9em→每选项独立一行；否则 2 个/行(makebox 17.9em)；否则 4 个/行(makebox 8.9em)。
 * 每个选项用 makebox 固定制表位，保证对齐且下一题不会粘连。
 */
function renderOptionBlock(options: RenderOption[]): string {
  if (!options.length) return "";
  const opts = options.slice(0, 5);
  const widthLines = opts
    .map((o) => `\\settowidth{\\optw}{${texEscapeText(String(o.option_key))}．${texEscapeText(o.option_text)}${"\\qquad"}}\\ifdim\\optw>\\optmax\\setlength{\\optmax}{\\optw}\\fi`)
    .join("\n");
  // two-per-row branch（makebox 宽度用字面量，勿用未定义变量）
  const too = (o: RenderOption) => `\\makebox[17.9em][l]{${texEscapeText(String(o.option_key))}．${texEscapeText(o.option_text)}${"\\qquad"}}`;
  const fo = (o: RenderOption) => `\\makebox[8.9em][l]{${texEscapeText(String(o.option_key))}．${texEscapeText(o.option_text)}${"\\qquad"}}`;
  const twoRow: Array<string[]> = [];
  let cur: string[] = [];
  for (const o of opts) { cur.push(too(o)); if (cur.length === 2) { twoRow.push(cur); cur = []; } }
  if (cur.length) twoRow.push(cur);
  const twoBlock = twoRow.map((row) => `\\noindent\\hspace*{2.0em}${row.join("")}\\par`).join("\n");
  // one-per-line branch
  const oneBlock = opts.map((o) => `\\noindent\\hspace*{2.0em}${texEscapeText(String(o.option_key))}．${texEscapeText(o.option_text)}${"\\qquad"}\\par`).join("\n");
  // four-per-row branch
  const fourBlock = `\\noindent\\hspace*{2.0em}${opts.map(fo).join("")}\\par`;
  return [
    "\\setlength{\\optmax}{0pt}",
    widthLines,
    `\\setlength{\\slotfour}{8.9em}\\setlength{\\slottwo}{17.9em}`,
    "\\ifdim\\optmax>\\slotfour",
    "\\ifdim\\optmax>\\slottwo",
    oneBlock,
    "\\else",
    twoBlock,
    "\\fi",
    "\\else",
    fourBlock,
    "\\fi",
  ].join("\n");
}

function renderItem(item: RenderItem, number: number): string {
  const isInlineType = item.stem_format === "single_choice" || item.stem_format === "multiple_choice" || item.stem_format === "fill_blank" || item.stem_format === "true_false";
  // skill PDF 铁律⑤：选择/填空题干把逻辑行 join 成单个自然段，防逗号处硬断；解答题保留分段以对齐子问。
  const stemRaw = isInlineType
    ? (item.stem_markdown || "（题目内容）").replace(/[ \t\r]*\n[ \t\r]*/g, " ")
    : (item.stem_markdown || "（题目内容）");
  const ind = hangingIndent(number);
  const stemBlock = [
    `\\begingroup\\parskip=0pt\\leftskip=0.5em\\hangindent=${ind}\\hangafter=1\\noindent\\textbf{${number}．}`,
    `${texParagraph(stemRaw).trim()}\\par\\endgroup`,
  ].filter((part) => part.trim().length > 0).join("");
  // 选择题答案括号内留两个全角字符宽（题库自带 ()/() 太窄，替换为两个全角空格）
  const isChoice = item.stem_format === "single_choice" || item.stem_format === "multiple_choice";
  const stemOut = isChoice
    ? stemBlock.replace(/[（(][ 　]*[）)]/g, (m) => (m.includes("（") ? "（\u3000\u3000）" : "(\u3000\u3000)"))
    : stemBlock;
  const optionBlock = renderOptionBlock(item.options ?? []);
  const answerSpace = item.stem_format === "fill_blank"
  // 填空/解答留白（skill：填空保留下划线并留作答空间）
    ? "\\vspace{18pt}"
    : item.stem_format === "open_solution"
      ? `\\vspace{${solutionSpace(countSubquestions(item.stem_markdown))}}`
      : "";
  return [
    "",
    optionBlock ? `${stemOut}\n\\Needspace{30mm}\n${optionBlock}\n${answerSpace}` : `${stemOut}\n${answerSpace}`,
  ].join("\n");
}

/** 题型分组：按 skill 默认题序 单选→多选→填空→判断→解答，中文序号一节一标题。 */
const SECTIONS: Array<{ format: string; label: string; desc: string }> = [
  { format: "single_choice", label: "一、单项选择题", desc: "在每小题给出的选项中只有一项是符合题目要求的．" },
  { format: "multiple_choice", label: "二、多项选择题", desc: "在每小题给出的选项中有多项符合题目要求，全部选对得分，漏选、错选均不得分．" },
  { format: "fill_blank", label: "三、填空题", desc: "将答案填写在答题卡对应横线上．" },
  { format: "true_false", label: "四、判断题", desc: "判断正误，正确的画“√”，错误的画“×”．" },
  { format: "open_solution", label: "五、解答题", desc: "解答应写出文字说明、证明过程或演算步骤．" },
];

const CN_NUM = ["一", "二", "三", "四", "五"];

/** 题型名：单选/多选合并为一节，节内若混入多选称"选择题"，否则称"单项选择题"；其余按题型展开。 */
function sectionTypeName(format: string, hasMultiple: boolean): string {
  switch (format) {
    case "single_choice": return "单项选择题";
    case "multiple_choice": return "多项选择题";
    case "fill_blank": return "填空题";
    case "true_false": return "判断题";
    case "open_solution": return "解答题";
    default: return "选择题";
  }
}

export function buildTex(paper: RenderPaper): string {
  const title = texEscapeText(paper.title.trim() || "数学试卷");
  // 按 item_order 排序后按题型分组，每节只含本题型题目。
  const sorted = [...paper.items].sort((a, b) => a.item_order - b.item_order);
  const hasMultiple = sorted.some((it) => it.stem_format === "multiple_choice");
  const present = SECTIONS
    .filter((section) => sorted.some((it) => it.stem_format === section.format))
    .map((section) => {
      const rows = sorted
        .filter((it) => it.stem_format === section.format)
        .map((it) => ({ item: it, num: 0 }));
      return { ...section, rows };
    });
  // 跨节连续编号：1, 2, 3, ...
  let counter = 0;
  for (const section of present) {
    for (const row of section.rows) {
      counter++;
      row.num = counter;
    }
  }
  const sectionBodies = present
    .map((section, si) => {
      const label = `${CN_NUM[si] ?? String(si + 1)}、${sectionTypeName(section.format, hasMultiple)}`;
      const isOpen = section.format === "open_solution";
      const total = section.rows.length;
      const blurb = `本大题共 ${total} 小题，${section.desc}`;
      const heading = `\\begingroup\\parskip=0pt\\linespread{1.3}\\selectfont\\heiti\\hangindent=2em\\hangafter=1\\noindent ${label}：${blurb}\\par\\endgroup\\nobreak`;
      const body = section.rows
        .map(({ item, num }) => {
          const leading = isOpen ? "\\solnewq" : "";
          return `${leading}\n\\Needspace{30mm}\n${renderItem(item, num)}`;
        })
        .join("\n\\vspace{1.5pt}\n");
      return ["", heading, "\\Needspace{40mm}", body].join("\n");
    })
    .join("\n");
  return `\\documentclass[11pt]{ctexart}
\\usepackage[a4paper,top=3cm,bottom=3cm,left=3.5cm,right=3.5cm]{geometry}
\\usepackage{graphicx}
\\usepackage{amsmath,amssymb,booktabs,needspace,xcolor}
\\setmainfont{Times New Roman}
\\setCJKmainfont{SimSun}
\\setCJKsansfont{SimHei}
\\setCJKfamilyfont{zhhei}{SimHei}
\\setCJKfamilyfont{zhxingkai}{STXingkai}
\\DeclareSymbolFont{operators}{TU}{TimesNewRoman(0)}{m}{n}
\\newcommand{\\figno}[1]{\\textnormal{#1}}
\\xeCJKsetup{CJKmath=true}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{4pt}
\\sloppy
\\emergencystretch=3em
\\pagestyle{plain}
\\newlength{\\optw}
\\newlength{\\optmax}
\\newlength{\\slotfour}
\\newlength{\\slottwo}
\\setlength{\\slotfour}{8.9em}
\\setlength{\\slottwo}{17.9em}
\\newcounter{solcount}
\\newcommand{\\solnewq}{%
  \\ifdim\\pagetotal<60pt\\relax
    \\setcounter{solcount}{1}%
  \\else
    \\stepcounter{solcount}%
  \\fi
  \\ifnum\\value{solcount}>2
    \\clearpage
    \\setcounter{solcount}{1}%
  \\fi
}
\\AtBeginDocument{\\setcounter{solcount}{0}}
\\begin{document}
\\zihao{5}
{\\begingroup\\parskip=0pt\\centering
\\zihao{2}\\CJKfamily{zhxingkai}\\linespread{1.0}\\selectfont ${title}\\par\\endgroup}
\\vspace{12pt}
${sectionBodies}
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

/** 速查表一行最多容纳的题目列数；超过则分块堆叠（skill 铁律⑦ 合并表，每块内部仍为"题号一行+答案一行"）。 */
const ANSWER_TABLE_MAX_CELLS = 15;

/** 速查表：单选+多选合并成一张表，题号一行、答案一行；超过 15 题自动分块续排。 */
function buildAnswerTable(choiceItems: Array<RenderAnswerItem & { num: number }>): string {
  const blocks: string[] = [];
  for (let i = 0; i < choiceItems.length; i += ANSWER_TABLE_MAX_CELLS) {
    const chunk = choiceItems.slice(i, i + ANSWER_TABLE_MAX_CELLS);
    const numbers = chunk.map((item) => String(item.num)).join(" & ");
    const answers = chunk.map((item) => texEscapeText(item.answer_text || "待定")).join(" & ");
    const cols = `|c${"|c".repeat(chunk.length)}|`;
    blocks.push(
      `\\begin{tabular}{${cols}}\n\\hline\n{\\heiti 题号} & ${numbers} \\\\\n\\hline\n{\\heiti 答案} & ${answers} \\\\\n\\hline\n\\end{tabular}`,
    );
  }
  return blocks.join("\n\\vspace{2pt}\n");
}

function renderAnswerItem(item: RenderAnswerItem, number: number): string {
  const hang = number <= 9 ? "1.5em" : "2em";
  const isSolution = item.stem_format === "open_solution";
  const need = isSolution ? "\\Needspace{12mm}" : "\\Needspace{15mm}";
  const sep = isSolution ? "\\vspace{\\baselineskip}" : "\\vspace{0.5\\baselineskip}";
  const answer = texParagraph(item.answer_text || "待人工核对");
  const analysis = texParagraph(item.analysis_text || "（解析待补充）");
  return [
    "",
    need,
    `{\\begingroup\\parskip=0pt\\leftskip=0.5em\\hangindent=${hang}\\hangafter=1`,
    `\\noindent\\textbf{${number}．}{\\heiti【答案】}${answer}\\par\n\n{\\heiti【解析】}${analysis}`,
    `\\par\\endgroup}`,
    sep,
  ].join("\n");
}

export function buildAnswerTex(paper: RenderAnswerPaper): string {
  const title = texEscapeText(paper.title.trim() || "数学试卷");
  const sorted = [...paper.items].sort((a, b) => a.item_order - b.item_order);
  // 跨节连续编号
  let counter = 0;
  const numbered = sorted.map((item) => ({ ...item, num: ++counter }));
  const choiceItems = numbered.filter((item) => item.stem_format === "single_choice" || item.stem_format === "multiple_choice");
  const sections = ANSWER_SECTION_ORDER
    .map((format) => ({ format, rows: numbered.filter((item) => item.stem_format === format) }))
    .filter((section) => section.rows.length > 0);
  const sectionBodies = sections
    .map((section, index) => {
      const heading = `${CN_NUM[index] ?? String(index + 1)}、${ANSWER_SECTION_LABEL[section.format] ?? section.format}`;
      const body = section.rows.map((item) => renderAnswerItem(item, item.num)).join("\n");
      return `\\begingroup\\parskip=0pt\\linespread{1.3}\\selectfont\\heiti\\hangindent=2em\\hangafter=1\\noindent ${heading}\\par\\endgroup\\nobreak\n${body}`;
    })
    .join("\n\n");
  const answerTable =
    choiceItems.length > 0
      ? `\n\\begin{center}\\vspace{0pt}{\\heiti 选择题答案速查表}\\\\[2pt]\n${buildAnswerTable(choiceItems)}\n\\end{center}\n\\vspace{6pt}`
      : "";
  return `\\documentclass[11pt]{ctexart}
\\usepackage[a4paper,top=3cm,bottom=3cm,left=3.5cm,right=3.5cm]{geometry}
\\usepackage{graphicx}
\\usepackage{amsmath,amssymb,booktabs,needspace,xcolor}
\\setmainfont{Times New Roman}
\\setCJKmainfont{SimSun}
\\setCJKsansfont{SimHei}
\\setCJKfamilyfont{zhhei}{SimHei}
\\setCJKfamilyfont{zhxingkai}{STXingkai}
\\DeclareSymbolFont{operators}{TU}{TimesNewRoman(0)}{m}{n}
\\newcommand{\\figno}[1]{\\textnormal{#1}}
\\xeCJKsetup{CJKmath=true}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{4pt}
\\sloppy
\\emergencystretch=3em
\\pagestyle{plain}
\\newlength{\\optw}
\\newlength{\\optmax}
\\newlength{\\slotfour}
\\newlength{\\slottwo}
\\setlength{\\slotfour}{8.9em}
\\setlength{\\slottwo}{17.9em}
\\begin{document}
\\zihao{5}
{\\begingroup\\parskip=0pt\\centering
\\zihao{2}\\CJKfamily{zhxingkai}\\linespread{1.0}\\selectfont ${title}参考答案与解析\\par\\endgroup}
\\vspace{10pt}
${answerTable}
${sectionBodies}
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