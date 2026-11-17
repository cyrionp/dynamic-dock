import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Tauri reads the built frontend from ../dist. Two pages: the dock itself
// and the settings window.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "esnext",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dock: fileURLToPath(new URL("index.html", import.meta.url)),
        settings: fileURLToPath(new URL("settings.html", import.meta.url)),
      },
    },
  },
});
