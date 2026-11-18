/// <reference types="vite/client" />

interface DesktopMeta {
  isDesktop: boolean;
  platform: string;
}

interface WorkspaceBridge {
  loadSharedWorkspace: () => Promise<{
    ok: boolean;
    workspace?: unknown;
    revision?: number;
    error?: string;
    // 讀入時補上了條目編號，需要寫回資料檔。
    needsSave?: boolean;
  }>;
  saveSharedWorkspace: (
    workspace: unknown,
    expectedRevision?: number,
  ) => Promise<{
    ok: boolean;
    conflict?: boolean;
    revision?: number;
    workspace?: unknown;
    error?: string;
  }>;
  getSharedWorkspacePath: () => Promise<string>;
  getWorkspaceStorageInfo: () => Promise<{
    path: string;
    defaultPath: string;
    envLocked: boolean;
    envPath: string | null;
  }>;
  setSharedWorkspacePath: (
    nextPath: string,
    workspace?: unknown,
  ) => Promise<{ ok: boolean; path?: string; revision?: number; error?: string }>;
  resetSharedWorkspacePath: (
    workspace?: unknown,
  ) => Promise<{ ok: boolean; path?: string; revision?: number; error?: string }>;
  pickSharedWorkspacePath: () => Promise<string | null>;
  exportWorkspaceFile: (
    workspace: unknown,
    suggestedFileName?: string,
  ) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  importWorkspaceFile: () => Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    error?: string;
    data?: unknown;
  }>;
  // 桌面版：經由主程序寫入系統剪貼簿。
  writeClipboardText?: (text: string) => Promise<boolean>;
  onExternalWorkspaceChanged?: (
    handler: (payload: { revision?: number }) => void,
  ) => () => void;
  onCloseFlushRequest?: (
    handler: () => Promise<{ saved: boolean; hasUnsavedDraft: boolean }>,
  ) => () => void;
}

interface AppearanceBridge {
  getAppearance: () => Promise<{
    theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
    cardStyle: "changbian" | "outline" | "frosted";
  }>;
  setAppearance: (appearance: {
    theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
    cardStyle: "changbian" | "outline" | "frosted";
  }) => Promise<{
    theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
    cardStyle: "changbian" | "outline" | "frosted";
  }>;
  onAppearanceChanged?: (
    handler: (appearance: {
      theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
      cardStyle: "changbian" | "outline" | "frosted";
    }) => void,
  ) => () => void;
}

type SearchBridgeScope = "project" | "chapter" | "time" | "summary" | "source" | "note" | "citation" | "refId";

interface SearchBridgeCriteria {
  query: string;
  queryScopes?: SearchBridgeScope[];
  tag: string;
  citationTitle: string;
  projectId?: string;
  chapterId?: string;
  limit?: number;
}

interface SearchBridgeResult {
  projectId: string;
  chapterId: string;
  entryId: string;
  projectTitle: string;
  chapterTitle: string;
  timeText: string;
  summaryText: string;
  snippet: string;
  citation: string;
  tags: string[];
}

interface SearchBridgeStatus {
  enabled: boolean;
  ready: boolean;
  dbPath: string;
  rowCount: number;
  lastIndexedAt: number;
  message: string;
  backend: string;
}

interface SearchBridge {
  query: (criteria: SearchBridgeCriteria) => Promise<SearchBridgeResult[] | null>;
  getStatus: () => Promise<SearchBridgeStatus>;
}

interface Window {
  desktopMeta?: DesktopMeta;
  workspaceBridge?: WorkspaceBridge;
  appearanceBridge?: AppearanceBridge;
  searchBridge?: SearchBridge;
}
