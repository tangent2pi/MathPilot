import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";

const options = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
    { left: "$", right: "$", display: false },
  ],
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
  ignoredClasses: ["no-math", "katex"],
  throwOnError: false,
  strict: "warn",
  trust: false,
};

/** Render TeX delimiters in trusted text nodes without interpreting HTML. */
export function renderMath(root: HTMLElement | Document = document): void {
  const element = root instanceof Document ? root.body : root;
  renderMathInElement(element, options);
}
