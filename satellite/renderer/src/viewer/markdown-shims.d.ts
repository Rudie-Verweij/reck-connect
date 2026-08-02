// Type shims for markdown-pipeline packages that ship without usable .d.ts
// files for the entry points we import.
//
// markdown-it-task-lists is not on DefinitelyTyped; the runtime export is a
// plugin function we can treat as a MarkdownIt PluginSimple.

declare module "markdown-it-task-lists" {
  import type { PluginSimple } from "markdown-it";
  const taskLists: PluginSimple;
  export default taskLists;
}

// katex ships types for its main entry but not for the auto-render contrib
// bundle (`dist/contrib/auto-render.mjs`). We only ever call it as
// `renderMathInElement(element, options)` — see markdownEnhancers.ts, which
// owns the option shape.
declare module "katex/contrib/auto-render" {
  const renderMathInElement: (
    element: HTMLElement,
    options?: Record<string, unknown>,
  ) => void;
  export default renderMathInElement;
}
