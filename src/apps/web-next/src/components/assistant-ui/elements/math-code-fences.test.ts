import assert from "node:assert/strict";
import test from "node:test";
import { recoverMathCodeFences } from "./math-code-fences";

test("screenshot equations become display math instead of empty-header code blocks", () => {
  for (const equation of ["A + B + C = 180°", "a / sinA = b / sinB = c / sinC", "c² = a² + b² - 2ab·cosC"]) {
    const converted = recoverMathCodeFences(`\n\`\`\`\n${equation}\n\`\`\`\n`);
    assert.ok(converted.includes("$$"));
    assert.ok(!converted.includes("```"));
  }
  assert.ok(recoverMathCodeFences("```\na / sinA = b / sinB\n```").includes("\\frac{a}{\\sin A}"));
});
test("programs, prose, incomplete fences and existing LaTeX stay unchanged", () => {
  for (const input of ["```js\nconst x = 1 + 2;\n```", "```\nreturn x + 1\n```", "```\nx = f(a) + 1\n```", "```\n说明 = 更多文字\n```", "```\na + b = c", "$$a+b=c$$"]) {
    assert.equal(recoverMathCodeFences(input), input);
  }
});
