import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "renderer"),
  base: "./",
  resolve: {
    alias: {
      "@proto": path.resolve(__dirname, "../proto"),
      "@client-core": path.resolve(__dirname, "../client-core/src"),
      // client-core source lives outside this package, so Vite's default
      // node-resolve can't find its @xterm/* deps in our node_modules.
      // Explicitly point them at ours.
      "@xterm/xterm": path.resolve(__dirname, "node_modules/@xterm/xterm"),
      "@xterm/addon-fit": path.resolve(__dirname, "node_modules/@xterm/addon-fit"),
      "@xterm/addon-webgl": path.resolve(__dirname, "node_modules/@xterm/addon-webgl"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    // an earlier release: emit both index.html (main window) and popout.html
    // (detached pane window) so electron-builder packs both into the
    // asar. Without rollupOptions.input, vite picks up only `index.html`
    // by default and the popout would 404 in the packaged app.
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "renderer/index.html"),
        popout: path.resolve(__dirname, "renderer/popout.html"),
        fileViewer: path.resolve(__dirname, "renderer/file-viewer.html"),
        dictationLab: path.resolve(__dirname, "renderer/dictation-lab.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
