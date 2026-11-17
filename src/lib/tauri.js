// Thin bridge to the Rust side. Outside Tauri (plain `npm run dev` in a
// browser) the calls quietly do nothing, so the UI can still be worked on.

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function call(cmd, args) {
  if (!inTauri) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function on(event, handler) {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, (e) => handler(e.payload));
}

// Which window this page is in: "dock" on the main screen, "dock-<display>"
// on the others, "settings".
const windowLabel = (inTauri && window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label) || "dock";
const isPrimaryDock = windowLabel === "dock";

export { inTauri, windowLabel, isPrimaryDock };
