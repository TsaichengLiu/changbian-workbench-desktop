const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopMeta", {
  isDesktop: true,
  platform: process.platform,
});

contextBridge.exposeInMainWorld("workspaceBridge", {
  loadSharedWorkspace: () => ipcRenderer.invoke("workspace:load-shared"),
  saveSharedWorkspace: (workspace, expectedRevision) =>
    ipcRenderer.invoke("workspace:save-shared", workspace, expectedRevision),
  getSharedWorkspacePath: () => ipcRenderer.invoke("workspace:shared-path"),
  getWorkspaceStorageInfo: () => ipcRenderer.invoke("workspace:storage-info"),
  setSharedWorkspacePath: (nextPath, workspace) =>
    ipcRenderer.invoke("workspace:set-shared-path", nextPath, workspace),
  resetSharedWorkspacePath: (workspace) =>
    ipcRenderer.invoke("workspace:reset-shared-path", workspace),
  pickSharedWorkspacePath: () => ipcRenderer.invoke("workspace:pick-shared-path"),
  exportWorkspaceFile: (workspace, suggestedFileName) =>
    ipcRenderer.invoke("workspace:export-file", workspace, suggestedFileName),
  importWorkspaceFile: () => ipcRenderer.invoke("workspace:import-file"),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  onExternalWorkspaceChanged: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("workspace:external-change", listener);
    return () => ipcRenderer.removeListener("workspace:external-change", listener);
  },
  onCloseFlushRequest: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = async (_event, requestId) => {
      let result;
      try {
        result = await handler();
      } catch {
        result = { saved: false, hasUnsavedDraft: false };
      }
      ipcRenderer.send("app:close-flush-done", requestId, result);
    };
    ipcRenderer.on("app:close-flush-request", listener);
    ipcRenderer.send("app:close-flush-ready", true);
    return () => {
      ipcRenderer.removeListener("app:close-flush-request", listener);
      ipcRenderer.send("app:close-flush-ready", false);
    };
  },
});

contextBridge.exposeInMainWorld("appearanceBridge", {
  getAppearance: () => ipcRenderer.invoke("appearance:get"),
  setAppearance: (appearance) => ipcRenderer.invoke("appearance:set", appearance),
  onAppearanceChanged: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, appearance) => {
      handler(appearance);
    };
    ipcRenderer.on("appearance:changed", listener);
    return () => {
      ipcRenderer.removeListener("appearance:changed", listener);
    };
  },
});

contextBridge.exposeInMainWorld("searchBridge", {
  query: (criteria) => ipcRenderer.invoke("search:query", criteria),
  getStatus: () => ipcRenderer.invoke("search:status"),
});
