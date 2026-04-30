const { ipcRenderer } = require("electron");

function ensureHintLayer(text) {
  try {
    const existing = document.getElementById("bookget-popup-hint");
    if (existing) {
      existing.textContent = text;
      return;
    }

    const layer = document.createElement("div");
    layer.id = "bookget-popup-hint";
    layer.textContent = text;
    layer.style.position = "fixed";
    layer.style.top = "12px";
    layer.style.right = "12px";
    layer.style.zIndex = "2147483647";
    layer.style.padding = "8px 12px";
    layer.style.background = "rgba(20,20,20,0.85)";
    layer.style.color = "#f7f7f7";
    layer.style.fontSize = "13px";
    layer.style.fontFamily = "Segoe UI, Microsoft YaHei, sans-serif";
    layer.style.borderRadius = "10px";
    layer.style.backdropFilter = "blur(4px)";
    layer.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
    layer.style.pointerEvents = "none";
    document.documentElement.appendChild(layer);
  } catch {
    // Ignore DOM injection errors on restricted pages.
  }
}

ipcRenderer.on("popup:init", (_event, payload) => {
  const hint = payload?.hint || "完成后按 F8，取消按 Esc";
  ensureHintLayer(hint);
});

window.addEventListener("DOMContentLoaded", () => {
  ensureHintLayer("完成后按 F8，取消按 Esc");
});
