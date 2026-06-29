// Type shim for markdown-it plugins that ship without their own .d.ts files.
//
// markdown-it-task-lists is not on DefinitelyTyped; the runtime export is a
// plugin function we can treat as a MarkdownIt PluginSimple.

declare module "markdown-it-task-lists" {
  import type { PluginSimple } from "markdown-it";
  const taskLists: PluginSimple;
  export default taskLists;
}
