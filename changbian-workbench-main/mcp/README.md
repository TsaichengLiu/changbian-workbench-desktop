# 長編工作臺 MCP Server

啟動：

```bash
npm run mcp:start
```

預設資料檔：

- `~/.changbian-workbench/workspace.json`
- 可用 `CHANGBIAN_MCP_STORE` 覆蓋。

可用工具：

- `list_projects`
- `create_project`
- `create_chapter`
- `add_entry`
- `search_entries`

`add_entry` 必填 `project_id`、`chapter_id`、`source_text`；史料一律錄入章節之下，不存在「未分章」的專案層級史料。  
其餘欄位：`time_text`、`summary`、`note`、`citation`。  
`search_entries` 的關鍵詞會匹配時間、摘要、史料文本、備註、引文註釋。

示例（MCP 客戶端配置片段）：

```json
{
  "mcpServers": {
    "changbian-workbench": {
      "command": "npm",
      "args": ["run", "mcp:start"],
      "cwd": "/path/to/changbian-workbench"
    }
  }
}
```
