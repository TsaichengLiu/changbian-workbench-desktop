# 長編工作臺 (History Research Workbench)

用於歷史研究長編整理的桌面化工作臺，支持：

- 專案管理（可新增/改名/刪除/拖拽排序）
- 專案下章節管理（可選，支援拖拽排序）
- 史料四元素錄入：時間、史料文本、備註、引文註釋
- 當前層級史料拖拽排序（便於處理非標準紀年）
- 專案與史料的複製 / 粘貼（跨專案搬運）
- 備註 `#標籤` 解析與標籤過濾檢索
- 高級檢索彈窗：按關鍵詞 / 標籤 / 引文《》書名檢索，並可將結果導入新專案、新章節、既有專案、既有章節
- 左欄合併：合併專案、合併章節（章節合併為新章節，來源不刪除）
- 全局檢索（繁簡通用，例：`長` 可命中 `长`）
- 匯出 `txt` / `docx` / `xlsx`
- MCP Server（供 agent/LLM 錄入史料）

## 技術設計

- 前端：`React + TypeScript + Vite`
- 桌面殼：`Electron`
- 匯出：
  - Word: `docx`
  - Excel: `xlsx`
- 繁簡檢索：`opencc-js`
- 本地資料儲存：`workspace.json`（主資料）+ `SQLite FTS5`（全文索引）

## 開發與啟動

```bash
npm install
npm run dev
```

## Windows 使用手冊

- 請見 `WINDOWS-使用手冊.md`

## 打包 macOS

```bash
npm run dist:mac
```

## 打包 Windows（Windows 10 / 11）

已配置主流架構：

- `x64`（Intel / AMD）
- `arm64`（Windows on ARM）

打包命令：

```bash
# 生成 Windows 全部目標（nsis + portable）
npm run dist:win

# 僅 x64
npm run dist:win:x64

# 僅 arm64
npm run dist:win:arm64
```

輸出目錄均為 `release/`。

說明：

- `nsis`：安裝版（可選安裝路徑）
- `portable`：免安裝可攜版（x64）
- `dist:win:arm64` 僅輸出 arm64 安裝版（不含 portable）
- 建議在 Windows 主機上執行上述打包命令，以獲得最穩定的 native module 打包結果

## 專案結構

- `src/`：界面、狀態與匯出邏輯
- `electron/`：桌面啟動殼（主進程 + preload）
- `dist/`：前端構建輸出（build 後）
- `release/`：桌面安裝包輸出（dist:* 後）
- `mcp/server.cjs`：可獨立啟動的 MCP server（stdio）
- `electron/search-index.cjs`：本地 SQLite FTS5 索引與查詢服務

## MCP Server（給 agent / LLM 接入）

```bash
npm run mcp:start
```

- 默認資料檔：`~/.changbian-workbench/workspace.json`
- 索引檔：與資料檔同目錄、同檔名基底，副檔名為 `.fts5.sqlite`
- 可用環境變數覆蓋：`CHANGBIAN_MCP_STORE=/your/path/workspace.json`
- Electron 桌面版會同步同一份共享檔（啟動時讀取、編輯時寫回）

已提供工具：
- `list_projects`
- `create_project`
- `create_chapter`
- `add_entry`
- `search_entries`

## 後續可擴展

- 自動排序策略（僅公元紀年排序，其他歸併）
- 依引文來源自動聚類
- 本地檔案式資料庫（SQLite）
- iCloud/雲同步
