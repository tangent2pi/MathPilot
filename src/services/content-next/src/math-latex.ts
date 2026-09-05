/**
 * math-latex.ts —— 组卷答案/解析的数学排版归一。
 *
 * AI 与题库给出的答案/解析是"通俗符号"纯文本（√3、π/3、45°、△ABC、sin A、a² 等），
 * 直接渲染会因 render 按纯文本处理而公式错乱。本模块在**入库前**把这些数学片段
 * 转成 LaTeX 数学（$...$），使 PDF 与速查表正确排版；并提供一个反向
 * latexToCasual，用于在线编辑器展示通俗符号（决策：库存 LaTeX，编辑器写通俗符号，保存时再转）。
 *
 * 转换是"尽力而为"：覆盖常见高中符号（√ 根式、希腊字母、分数、函数、指数、
 * 角度、比较/运算符号、几何符号），对无法识别的片段保持原样，绝不臆造。
 */

/** 数学模式下的字体更正的希腊字母与算符（按最常用频度收录）。 */
const MATH_SYMBOL: Record<string, string> = {
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta",
  "θ": "\\theta", "λ": "\\lambda", "μ": "\\mu", "σ": "\\sigma",
  "φ": "\\varphi", "ρ": "\\rho", "ω": "\\omega", "ε": "\\varepsilon",
  "τ": "\\tau", "η": "\\eta", "ξ": "\\xi", "ζ": "\\zeta", "κ": "\\kappa",
  "π": "\\pi", "Δ": "\\Delta", "Σ": "\\Sigma", "Γ": "\\Gamma", "Π": "\\Pi", "Ω": "\\Omega",
  "∠": "\\angle", "△": "\\triangle", "⊥": "\\perp", "∥": "\\parallel",
  "∈": "\\in", "∞": "\\infty", "∇": "\\nabla",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≡": "\\equiv", "≈": "\\approx",
  "±": "\\pm", "×": "\\times", "·": "\\cdot", "÷": "\\div",
  "→": "\\to", "⇐⇒": "\\Leftrightarrow", "⇔": "\\Leftrightarrow", "⇒": "\\Rightarrow", "←": "\\leftarrow",
};

const SUPERSCRIPT: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "⁺": "+", "⁻": "-",
};
const SUPERSCRIPT_CHARS = new Set(Object.keys(SUPERSCRIPT));
const SUBSCRIPT: Record<string, string> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
};
const SUBSCRIPT_CHARS = new Set(Object.keys(SUBSCRIPT));
const MATH_FUNCS = ["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "lg", "arcsin", "arccos", "arctan"];

/** 判定一个片段的"强数学信号"：含根号/希腊字母/特殊符号/运算/度/指数之一。 */
const STRONG_MATH = /[√α-ωΑ-Ω±×÷≤≥≠≡≈−‐·°∥⊥∠∈△∑∞Δ][^​]*/u;

/** 数学字符集合：数字、拉丁字母、希腊、运算符、括号、分数线、指数等（不含中文标点）。 */
const MATH_CHAR = "[0-9A-Za-zα-ωΑ-Ω√±×÷≤≥≠≡≈−‐·°∥⊥∠∈△∑∞½¼¾⅓⅔⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉()/.,=?]";

/** 常见斜体分数：½¼¾⅓⅔等 → \dfrac{n}{m}。 */
const VULGAR: Record<string, string> = {
  "½": "\\dfrac{1}{2}", "¼": "\\dfrac{1}{4}", "¾": "\\dfrac{3}{4}",
  "⅓": "\\dfrac{1}{3}", "⅔": "\\dfrac{2}{3}",
};

/**
 * 把单个"通俗数学串"转换为 LaTeX 数学体（不含 $ 包裹）。
 * 入参应为已被识别的数学片段。
 */
export function mathToLatex(input: string): string {
  let s = input.trim();
  if (!s) return s;
  // 0) 斜体分数先转
  for (const [k, v] of Object.entries(VULGAR)) s = s.split(k).join(v);
  // 1) 根式：√(…) 与 √x、 系数在前 3√2
  s = s.replace(/√\s*[(\[]([^)\]]*)[)\]]/g, (_m, g: string) => `\\sqrt{${g.trim()}}`);
  s = s.replace(/√([0-9]{1,4}(?:\.[0-9]+)?|α|β|π|e)/g, (_m, g: string) => `\\sqrt{${g}}`);
  s = s.replace(/(\d+)\s*(\\sqrt\{)/g, "$1$2");
  // 2) 上标/下标
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g, (ch) => `^{${SUPERSCRIPT[ch]}}`);
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (ch) => `_{${SUBSCRIPT[ch]}}`);
  // 对遗留的 `^数字`/`^字母` 统一补花括号，并避免已有花括号重复
  s = s.replace(/(?<!\^)\^([0-9A-Za-zα-ω](?![0-9A-Za-z]))/g, "^{$1}");
  // 3) 三角函数/对数：转直立体
  s = s.replace(new RegExp(`\\b(${MATH_FUNCS.join("|")})\\b`, "g"), "\\$1");
  // 4) 符号映射（键按长度降序，先替换多字符项）
  const keys = Object.keys(MATH_SYMBOL).sort((a, b) => b.length - a.length);
  for (const key of keys) s = s.split(key).join(MATH_SYMBOL[key]!);
  // 5) 已知命令紧跟拉丁字母时补空格，避免 \angleBAD / \piR / \cdotAB 合成一个无效命令名；
  //    利用命令名是已知字面串，Safe 不会拆坏 \sqrt{...} / \dfrac{...}（其后是 {）。
  const commandWords = Object.values(MATH_SYMBOL).concat(MATH_FUNCS.map((fn) => `\\${fn}`));
  for (const cmd of commandWords) {
    s = s.split(cmd).join("\u0000");
    s = s.replace(/\u0000(?=[A-Za-z])/g, `${cmd} `).replace(/\u0000/g, cmd);
  }
  // 6) 分数：NUM/DEN → \dfrac{NUM}{DEN}（NUM/DEN 为不含运算边界符的单项）
  s = s.replace(
    /([^+−×·÷±=≤≥≠<>\s\/()]+)\s*\/\s*([^+−×·÷±=≤≥≠<>\s\/()]+)/g,
    (_m, a: string, b: string) => `\\dfrac{${a}}{${b}}`,
  );
  return s;
}

/**
 * 把整段答案/解析文本中"通俗数学"片段转为 LaTeX，并以 $ 包裹。
 * 对已含 $...$ 的片段原样保留，避免二次包裹。
 */
export function casualToLatex(text: string): string {
  const parts = text.split(/(\$[^$\n]*\$)/g);
  return parts
    .map((part) => {
      if (part.length > 1 && part.startsWith("$") && part.endsWith("$")) return part;
      return wrapMathSpans(part);
    })
    .join("");
}

/** 在当前纯文本段中识别数学片段并逐个转换、$ 包裹。 */
function wrapMathSpans(segment: string): string {
  if (!segment) return segment;
  const spanRe = new RegExp(`${MATH_CHAR}(?:\\s*${MATH_CHAR})*`, "gu");
  let out = "";
  let last = 0;
  for (const match of segment.matchAll(spanRe)) {
    const raw = match[0];
    const start = match.index!;
    if (start > last) out += segment.slice(last, start);
    const core = raw.trim();
    const lead = raw.slice(0, raw.length - raw.trimStart().length);
    const leadLen = lead.length;
    out += lead;
    if (core && isMathSpan(core)) {
      const latex = mathToLatex(core);
      if (latex) out += `$${latex}$`;
      else out += core;
    } else {
      out += core;
    }
    if (core) out += raw.slice(leadLen + core.length);
    last = start + raw.length;
  }
  if (last < segment.length) out += segment.slice(last);
  return out;
}

function isMathSpan(span: string): boolean {
  if (!span) return false;
  if (/[√α-ωΑ-Ω×÷±≤≥≠≡≈−‐·°∥⊥∠∈△∑Δ][0-9A-Za-zα-ω√()=.]/u.test(span)) return true;
  if (/\d+\s*°/.test(span)) return true; // 独立"45°"等角度
  // 上/下标字符（⁰¹²… ₀₁₂…）本身就是数学强信号，孤立"x³""a₂"也应转
  if (/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(span)) return true;
  // 只含拉丁字母与数字但形如表达式（含 = 或确为 sin/cos 等函数）也视为数学
  if (/=/.test(span) && /[+−×÷=≤≥]/.test(span)) return true;
  // 中缀关系/运算式：首尾为数学记号且夹着一个关系符（如 "A ≤ B"、"a ≠ b"、"x + y")
  if (/[=≤≥≠≡≈±×÷+−<]/.test(span)
      && /^[0-9A-Za-zα-ω√]/u.test(span)
      && /[0-9A-Za-zα-ω√]$/u.test(span)) return true;
  if (/\//.test(span) && /[0-9]/.test(span)) return true; // 分数必含 /
  for (const fn of MATH_FUNCS) if (span.includes(fn)) return true;
  return false;
}

/** 反向：命令 → 通俗符号（无参处理，保留命令后的空格由外层主循环自然输出）。 */
const CMD_TO_SYM: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", theta: "θ", lambda: "λ", mu: "μ", sigma: "σ",
  varphi: "φ", rho: "ρ", omega: "ω", varepsilon: "ε", tau: "τ", eta: "η", xi: "ξ", zeta: "ζ", kappa: "κ",
  pi: "π", Delta: "Δ", Sigma: "Σ", Gamma: "Γ", Pi: "Π", Omega: "Ω",
  angle: "∠", triangle: "△", perp: "⊥", parallel: "∥", in: "∈", infty: "∞",
  leq: "≤", geq: "≥", neq: "≠", equiv: "≡", approx: "≈", pm: "±", times: "×", cdot: "·", div: "÷",
  to: "→", Leftrightarrow: "⇔", Rightarrow: "⇒", leftarrow: "←",
  left: "(", right: ")",
};
const REV_SUPER: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻",
};
const REV_SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
};
const FUNC_NAMES = new Set(MATH_FUNCS);

/** 读取从 s[index]（必须为 `{`）开始的一对花括号，返回括号内原文与结束下标。 */
function readGroup(s: string, index: number): { content: string; end: number } {
  let depth = 0;
  let j = index;
  for (; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") {
      if (--depth === 0) return { content: s.slice(index + 1, j), end: j + 1 };
    }
  }
  return { content: s.slice(index + 1), end: s.length };
}

/** 递归地把一段 LaTeX 数学文字转回通俗符号。 */
function reverseMath(inner: string): string {
  const rev = reverseMath; // 组内递归
  let out = "";
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === "\\") {
      const m = inner.slice(i).match(/\\([A-Za-z]+)/);
      if (m) {
        const cmd = m[1]!;
        i += m[0].length;
        const groups: string[] = [];
        while (inner[i] === "{") {
          const g = readGroup(inner, i);
          groups.push(rev(g.content));
          i = g.end;
        }
        if (groups.length && (cmd === "dfrac" || cmd === "frac")) {
          out += `${groups[0]}/${groups[1] ?? ""}`;
        } else if (cmd === "sqrt") {
          out += `√${groups[0] ?? ""}`;
        } else if (FUNC_NAMES.has(cmd)) {
          out += cmd + (cmd === "log" || cmd === "ln" || cmd === "lg" ? " " : "") + (groups[0] ? ` ${groups[0]}` : "");
        } else if (CMD_TO_SYM[cmd] !== undefined) {
          out += CMD_TO_SYM[cmd] + (groups[0] ? `${groups[0]}` : "");
        } else if (groups.length) {
          out += `\\${cmd}${groups.join("")}`;
        } else {
          out += `\\${cmd}`;
        }
        continue;
      }
      const esc = inner[i + 1];
      // 丢弃空分组 \( \) \{ \} 与间距符 \, \; \!，保留转义空格 \ 
      if (esc === "(" || esc === ")" || esc === "{" || esc === "}") { i += 2; continue; }
      if (esc === "\\" || esc === " " || esc === "," || esc === ";" || esc === "!") { i += 2; out += " "; continue; }
      out += c; i++; continue;
    }
    if (c === "{") {
      const g = readGroup(inner, i);
      out += rev(g.content);
      i = g.end;
      continue;
    }
    if (c === "}") { i++; continue; }
    if (c === "^" || c === "_") {
      i++;
      let g: string | null = null;
      if (inner[i] === "{") { const r = readGroup(inner, i); g = r.content; i = r.end; }
      else { g = inner[i] ?? ""; i++; }
      const body = rev(g ?? "");
      out += c === "^"
        ? (REV_SUPER[body] ?? `^${body}`)
        : (REV_SUB[body] ?? `_${body}`);
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * 反向：把本模块生成的 LaTeX 数学转回"通俗符号"，供在线编辑器展示。
 * 递归解析花括号嵌套与命令分组；无法识别的命令保留 LaTeX 原文，绝不丢弃内容。
 */
export function latexToCasual(text: string): string {
  return text.replace(/\$([^$\n]*)\$/g, (_m, inner: string) => reverseMath(inner));
}