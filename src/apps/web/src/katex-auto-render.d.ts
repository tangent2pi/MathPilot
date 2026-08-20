declare module "katex/contrib/auto-render" {
  type Delimiter = { left: string; right: string; display: boolean };
  type Options = {
    delimiters?: Delimiter[];
    ignoredTags?: string[];
    ignoredClasses?: string[];
    throwOnError?: boolean;
    strict?: boolean | "ignore" | "warn" | "error";
    trust?: boolean;
  };
  export default function renderMathInElement(element: HTMLElement, options?: Options): void;
}
