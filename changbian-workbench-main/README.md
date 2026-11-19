# 長編工作臺 (History Research Workbench)

用於歷史研究長編整理的桌面化工作臺，支持：

- 專案管理（可新增/改名/刪除/拖拽排序）
- 專案下章節管理（可選，支援拖拽排序）
- 史料四元素錄入：時間、史料文本、備註、引文註釋
- 當前層級史料拖拽排序（便於處理非標準紀年）
- 專案與史料的複製 / 粘貼（跨專案搬運）
- 備註 `#標籤` 解析與標籤過濾檢索
- 高級檢索彈窗：按關鍵詞 / 標籤 / 引文《》書名檢索，並可將結果導入新專案、新章節、既有專案、既有章節
- 高級檢索的模糊檢索：容許異文、脫文、衍文，按相似度（1 − 編輯距離 ÷ 檢索詞字數）排序，最低相似度可調；命中處相同的字標黃，不同的字標淺色加底線（在背景線程中比對，只在開啟時建立）
- 左欄合併：合併專案、合併章節（章節合併為新章節，來源不刪除）
- 持久回收站：專案、章節與史料可整批還原，保留最新 100 次刪除操作
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
- 本地資料儲存：`workspace.json`（帶 schema/revision 的主資料）+ `SQLite FTS5`（全文索引）
- 安全寫入：原子替換、程序間檔案鎖、revision 衝突偵測、上一版 `.bak`

## 開發與啟動

```bash
npm install
npm run dev
```

提交或打包前可執行完整檢查：

```bash
npm run check
```

## 打包 macOS

```bash
npm run dist:mac
```

打包產物位於 `release/`。

## 專案結構

- `src/`：界面、狀態與匯出邏輯
- `electron/`：桌面啟動殼（主進程 + preload）
- `dist/`：前端構建輸出（build 後）
- `release/`：桌面安裝包輸出（dist:mac 後）
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
- MCP 與桌面版同時寫入時會檢查 revision；偵測到外部更新會拒絕舊版本覆蓋

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
