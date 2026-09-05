import { casualToLatex } from "../../src/services/content-next/src/math-latex.ts";

// 测试混合格式
const samples = [
  "由余弦定理得 c^$2 = a$^2 + b^2 - $2ab cosC$",
  "则c^$2=a$^2+b^2",
  "只需比较(c+x)^2与(a+x)^2+(b+x)^2的大小",
  "因为a^2+b^$2=c$^2，且a+b>c",
];

for (const s of samples) {
  console.log("原始:", s);
  console.log("转换:", casualToLatex(s));
  console.log("---");
}
