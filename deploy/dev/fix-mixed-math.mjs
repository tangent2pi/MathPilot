/**
 * fixMixedMath — 修复混合格式答案数据。
 *
 * 核心问题：AI 生成的答案中，`^` 上标经常在 `$...$` 外面，如：
 * - `c^$2 = a$^2` 应该是 `$c^2 = a^2$`
 *
 * 策略：
 * 1. 先处理 `^` 在 `$...$` 外面的情况（如 `c^$...$` → `$c^...$`）
 * 2. 合并相邻的 `$...$` 片段
 * 3. 处理纯文本中的数学表达式
 */

/**
 * 修复混合格式答案。
 */
export function fixMixedMath(text) {
  let result = text;

  // 第一步：处理 `字母^$...$` 模式 → `$字母^...$`
  // 如 c^$2 = a$ → $c^2 = a$
  result = result.replace(/([a-zA-Z0-9])\^(\$[^$]*\$)/g, (_m, letter, math) => {
    const mathContent = math.slice(1, -1);
    return `$${letter}^${mathContent}$`;
  });

  // 第二步：处理 `$...$^字母/数字` 模式 → `$...^字母/数字$`
  // 如 $2 = a$^2 → $2 = a^2$
  result = result.replace(/(\$[^$]*\$)\^([a-zA-Z0-9{}]+)/g, (_m, math, exp) => {
    const mathContent = math.slice(1, -1);
    return `$${mathContent}^${exp}$`;
  });

  // 第三步：合并相邻的 `$...$` 片段（中间只有空格或运算符）
  // 模式：$A$ $B$ → $A B$
  result = result.replace(/\$([^$]*)\$\s*\$([^$]*)\$/g, (_m, a, b) => `$${a} ${b}$`);

  // 第四步：处理纯文本中的数学表达式（含 ^ 或 _）
  // 匹配：字母/数字/括号 + (^或_) + 字母/数字/括号 + 后续运算
  const mathPattern = /([a-zA-Z0-9()\[\]]+(?:[\^_][a-zA-Z0-9{}]+|[+\-*/][a-zA-Z0-9()\[\]]+)+)+/g;
  result = result.replace(mathPattern, (match) => {
    // 检查是否已经在 $...$ 内（简单策略：前后不是 $）
    return `$${match}$`;
  });

  return result;
}

// 测试
const samples = [
  "由余弦定理得 c^$2 = a$^2 + b^2 - $2ab cosC$",
  "则c^$2=a$^2+b^2",
  "只需比较(c+x)^2与(a+x)^2+(b+x)^2的大小",
  "因为a^2+b^$2=c$^2，且a+b>c",
  "设原直角三角形两条直角边分别为a、b，斜边为c，则c^2 = a^2+b^2。",
];

for (const s of samples) {
  console.log("原始:", s);
  console.log("修复:", fixMixedMath(s));
  console.log("---");
}
