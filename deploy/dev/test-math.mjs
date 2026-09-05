import { casualToLatex, latexToCasual } from "../../src/services/content-next/src/math-latex.ts";

let failed = 0;
function expect(name, got, want) {
  if (got === want) { console.log("PASS", name); return; }
  failed++;
  console.log("FAIL", name, "\n  got :", JSON.stringify(got), "\n  want:", JSON.stringify(want));
}

// --- casualToLatex：欢迎把"通俗符号"转成含 $ 的 LaTeX ---
expect("sqrt+func", casualToLatex("√3 sin A − cos A = 1，故 A = π/3"),
  "$\\sqrt{3} \\sin A − \\cos A = 1$，故 $A = \\dfrac{\\pi}{3}$");
expect("bc²", casualToLatex("由余弦定理 BC² = √7，故 BC = √7"),
  "由余弦定理 $BC^{2} = \\sqrt{7}$，故 $BC = \\sqrt{7}$");
expect("frac chain", casualToLatex("S = 1/2 · 2 × 3 × √3/2 = 3√3/2"),
  "$S = \\dfrac{1}{2} \\cdot 2 \\times 3 \\times \\dfrac{\\sqrt{3}}{2} = \\dfrac{3\\sqrt{3}}{2}$");
expect("angle-degree", casualToLatex("∠BAD = 30°，45°，△ABC"),
  "$\\angle BAD = 30°$，$45°$，$\\triangle ABC$");
expect("piR", casualToLatex("面积 πR² = π/2"),
  "面积 $\\pi R^{2} = \\dfrac{\\pi}{2}$");
expect("no-double-brace", casualToLatex("原式化为 b² + c² − a² = 2bc cos A"),
  "原式化为 $b^{2}$ + $c^{2} − a^{2} = 2bc \\cos A$");

// --- latexToCasual：把生成的 LaTeX 还原成通俗符号（编辑器展示） ---
expect("cas-sqrt", latexToCasual("故 BC = $\\sqrt{7}$"), "故 BC = √7");
expect("cas-frac", latexToCasual("$\\dfrac{\\sqrt{3}}{2}$"), "√3/2");
expect("cas-pi", latexToCasual("面积 $\\pi R^{2} = \\dfrac{\\pi}{2}$"), "面积 π R² = π/2");
expect("cas-angle", latexToCasual("$\\angle BAD = 30°$"), "∠ BAD = 30°");
expect("cas-unchanged", latexToCasual("故 $\\cos A$ 可知"), "故 cos A 可知");

// --- 幂等：对已是 LaTeX 的输入再次转换不破坏 ---
expect("idempotent", casualToLatex("故 $BC = \\sqrt{7}$"), "故 $BC = \\sqrt{7}$");
expect("idempotent2", casualToLatex("面积 $\\pi R^{2} = \\dfrac{\\pi}{2}$"), "面积 $\\pi R^{2} = \\dfrac{\\pi}{2}$");

// --- 选择题字母答案不应被误判为数学 ---
expect("letter-A", casualToLatex("A"), "A");
expect("letter-AC", casualToLatex("AC"), "AC");
expect("letter-in-text", casualToLatex("答案选 A，理由见下"), "答案选 A，理由见下");

// --- 额外符号覆盖：上标 4/5、比较符、正向含角度 ---
expect("super45", casualToLatex("x³ + y⁴ − z⁵ = 1"),
  "$x^{3}$ + $y^{4} − z^{5} = 1$");
expect("leq-geq", casualToLatex("若 A ≤ B 且 B ≥ C，则 a ≠ b"),
  "若 $A \\leq B$ 且 $B \\geq C$，则 $a \\neq b$");
expect("nested-rev", latexToCasual("$\\dfrac{2\\sqrt{3}}{3}$"), "2√3/3");
expect("sub-rev", latexToCasual("$x_{1} + y_{2}$"), "x₁ + y₂");
expect("func-arg", latexToCasual("$\\sin A \\cos B$"), "sin A cos B");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);