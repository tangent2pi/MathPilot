declare module "katex/contrib/auto-render" {
  type AutoRenderOptions = {
    delimiters?: ReadonlyArray<{ left: string; right: string; display: boolean }>;
    ignoredTags?: ReadonlyArray<string>;
    throwOnError?: boolean;
    strict?: string;
    trust?: boolean;
  };

  export default function renderMathInElement(
    element: HTMLElement,
    options?: AutoRenderOptions,
  ): void;
}
