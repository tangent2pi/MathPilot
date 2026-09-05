import { buildAnswerTex } from "/app/src/services/group-next/src/render.ts";
import { writeFile } from "node:fs/promises";

const paper = {
  title: "2026高一年级解三角形单元测试卷（一）",
  items: [
    {
      item_order: 0,
      stem_format: "single_choice",
      stem_markdown: "在△ABC 中，已知A=π/3，AB=2，AC=3，则BC=？",
      options: [
        { option_key: "A", option_text: "A．√7" },
        { option_key: "B", option_text: "B．2√2" },
        { option_key: "C", option_text: "C．√13" },
        { option_key: "D", option_text: "D．√11" },
      ],
      answer_text: "$\\sqrt{7}$",
      analysis_text: "由余弦定理 BC² = AB² + AC² - 2·AB·AC·cosA = 4 + 9 - 2×2×3×(1/2) = 7，故 BC = √7，故选 A。",
    },
    {
      item_order: 8,
      stem_format: "multiple_choice",
      stem_markdown: "关于△ABC 的形状，下列说法正确的是（  ）",
      options: [
        { option_key: "A", option_text: "A．若a²>b²+c²则A为钝角" },
        { option_key: "B", option_text: "B．a>b则A>B" },
        { option_key: "C", option_text: "C．sinA=sinB则A=B" },
        { option_key: "D", option_text: "D．锐角三角形则三边平方和关系" },
      ],
      answer_text: "AC",
      analysis_text: "对于 A：由余弦定理 cosA=(b²+c²-a²)/(2bc)<0，A 为钝角，A 正确。对于 B：由大边对大角，a>b 则 A>B，B 正确。对于 C：sinA=sinB 可能 A+B=π（此时 C=0 不构成三角形），故未必 A=B，C 错误。对于 D：表述不完整，D 错误。综上，选 AB。",
    },
    {
      item_order: 9,
      stem_format: "fill_blank",
      stem_markdown: "在△ABC 中，A=60°，b=1，c=2，则 a =______",
      options: [],
      answer_text: "$\\sqrt{3}$",
      analysis_text: "由余弦定理 a² = b² + c² - 2bc·cosA = 1 + 4 - 2×1×2×(1/2) = 3，故 a = √3。",
    },
    {
      item_order: 14,
      stem_format: "open_solution",
      stem_markdown: "三角形ABC 中，已知 a=2，b=3，A=60°，求 c 与面积。",
      options: [],
      answer_text: "(1) c = √7；(2) S = (3√3)/2",
      analysis_text: "(1) 由余弦定理 c² = a² + b² - 2ab·cosC，先求 C……(2) 面积 S = (1/2)ab·sinC。",
    },
  ],
};

const tex = buildAnswerTex(paper);
await writeFile("/tmp/answer_sample.tex", tex, "utf8");
console.log("answer.tex written, length", tex.length);
console.log(tex.slice(0, 1500));