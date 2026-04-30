const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bookgetBridge", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  pickDirectory: (defaultPath) => ipcRenderer.invoke("dialog:pick-directory", defaultPath),
  startDownload: (payload) => ipcRenderer.invoke("download:start", payload),
  pauseDownload: () => ipcRenderer.invoke("download:pause"),
  resumeDownload: (payload) => ipcRenderer.invoke("download:resume", payload),
  stopDownload: () => ipcRenderer.invoke("download:stop"),
  getSnapshot: () => ipcRenderer.invoke("download:snapshot"),
  exportLog: (targetDir) => ipcRenderer.invoke("download:export-log", targetDir),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  onRunnerEvent: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("runner:event", listener);
    return () => ipcRenderer.removeListener("runner:event", listener);
  },
});
