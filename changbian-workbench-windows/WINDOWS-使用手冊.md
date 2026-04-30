# 長編工作臺 Windows 使用手冊

版本：`0.1.2`  
適用系統：`Windows 10 / Windows 11`

## 1. 安裝包選擇

請依裝置架構選擇安裝檔：

- `長編工作臺-0.1.2-win-x64-setup.exe`：Intel/AMD 電腦安裝版（推薦）
- `長編工作臺-0.1.2-win-x64-portable.exe`：Intel/AMD 免安裝可攜版
- `長編工作臺-0.1.2-win-arm64-setup.exe`：Windows on ARM 安裝版

## 2. 安裝與首次啟動

### A. setup 安裝版

1. 雙擊 `.exe` 安裝檔。
2. 選擇安裝路徑並完成安裝。
3. 從開始選單或桌面捷徑啟動「長編工作臺」。

### B. portable 可攜版

1. 將可攜版 `.exe` 放到固定資料夾（例如 `D:\Apps\長編工作臺\`）。
2. 直接雙擊執行即可。

### C. 若 Windows SmartScreen 阻擋

1. 在提示視窗點「更多資訊」。
2. 點「仍要執行」。

說明：目前安裝包未做商業簽章，首次可能出現此提示，屬常見行為。

## 3. 是否可直接安裝與運行

可以。  
目前三個交付檔已完成打包驗證，可直接在對應 Windows 系統安裝或運行。

## 4. 主要功能（與 macOS 版一致）

- 專案/章節/史料管理（新增、改名、刪除、拖拽排序）
- 史料四元素錄入（時間、文本、備註、引文）
- 標籤 `#` 解析與篩選
- 全局檢索（繁簡通用）
- 高級檢索與結果匯入
- 專案合併、章節合併
- 匯出 `txt` / `docx` / `xlsx`
- MCP Server 同步同一份資料檔

## 5. 資料儲存位置（Windows）

預設資料檔路徑：

- `C:\Users\<你的帳號>\.changbian-workbench\workspace.json`

索引檔路徑（全文檢索）：

- 與 `workspace.json` 同目錄
- 檔名為 `workspace.fts5.sqlite`

設定檔：

- `C:\Users\<你的帳號>\.changbian-workbench\settings.json`

## 6. 備份與遷移

建議定期備份整個資料夾：

- `C:\Users\<你的帳號>\.changbian-workbench\`

更換電腦時，拷貝此資料夾到新機同位置，即可保留資料與設定。

## 7. 升級方式

### setup 版

1. 下載新版本 `setup.exe`。
2. 直接覆蓋安裝即可（資料不受影響）。

### portable 版

1. 下載新版本 portable。
2. 以新檔替換舊檔（或放新資料夾執行）。

## 8. 卸載

### setup 版

- 由 Windows「應用程式與功能」移除。

### portable 版

- 刪除 portable 執行檔即可。

注意：卸載不會刪除你的研究資料。  
若要完全清空，需手動刪除 `C:\Users\<你的帳號>\.changbian-workbench\`。

## 9. 常見問題

### Q1：打不開或提示架構不相容

請確認你下載的檔案對應 CPU 架構：

- 多數電腦：`x64`
- ARM 裝置：`arm64`

### Q2：啟動後看不到舊資料

請在程式內檢查「共享資料檔路徑」是否指向正確 `workspace.json`。

### Q3：檢索變慢

通常是索引尚在同步。等待幾秒後再查詢；必要時重啟一次應用程式。
