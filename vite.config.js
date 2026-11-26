import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Tauri reads the built frontend from ../dist. Three pages: the dock
// itself, the settings window and Dynamic Launcher.
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
        launcher: fileURLToPath(new URL("launcher.html", import.meta.url)),
      },
    },
  },
});
