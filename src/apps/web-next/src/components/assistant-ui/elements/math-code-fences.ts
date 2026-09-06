/** Recover short equation-only fences; named programming blocks remain verbatim. */
export function recoverMathCodeFences(markdown: string): string {
  return markdown.replace(/(^|\n)([ \t]{0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)/g,
    (original, before: string, indent: string, _fence: string, language: string, body: string) => {
      const lang = language.trim().toLowerCase();
      if (lang && !["math", "latex", "tex"].includes(lang)) return original;
      const value = body.trim();
      if (!value || value.length > 1200 || /\\(?:documentclass|usepackage)|\\begin\{document\}/.test(value)) return original;
      if (!lang) {
        const lines = value.split("\n");
        if (lines.length > 4 || lines.some(line => !/[=<>≤≥≈]/.test(line) || !/[+\-\/^²³°·]|\\(?:frac|sin|cos|tan|sqrt)/.test(line))) return original;
        if (!/^[A-Za-z0-9\s+\-*/^=<>≤≥≈≠²³°·πθαβγδΣ∑∞√(){}.,\\|]+$/.test(value)) return original;
        if (/\b(?:const|let|var|return|print|function|if|for|while|import|def|class|console)\b/.test(value) || /\w+\s*\(/.test(value.replace(/\b(?:sin|cos|tan)\s*\(/g, "("))) return original;
      }
      let math = value.replace(/²/g, "^{2}").replace(/³/g, "^{3}").replace(/°/g, "^{\\circ}").replace(/·/g, "\\cdot ");
      math = math.replace(/(?<!\\)\b(sin|cos|tan)(?=[A-Z\s(])/g, "\\$1 ");
      math = math.replace(/\b([A-Za-z0-9]+)\s*\/\s*(\\(?:sin|cos|tan)\s+[A-Za-z])\b/g, "\\frac{$1}{$2}");
      return `${before}${indent}$$\n${math}\n${indent}$$`;
    });
}
