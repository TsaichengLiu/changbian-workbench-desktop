# Windows 带代码签名发布方案

本方案目标：
- 让下载后的 `exe` 降低被 SmartScreen/Defender 拦截概率。
- 确保发布物可验证签名（时间戳有效，证书过期后仍可验证历史签名）。
- 把签名流程固定到 CI，减少人工失误。

---

## 1. 证书策略

推荐优先级：
1. **EV Code Signing（推荐）**
   - SmartScreen 建立信誉更快。
   - 适合面向公众分发。
2. **OV Code Signing（可用）**
   - 成本更低，但初期信誉建立慢。

证书保管建议：
- 不把 `.pfx` 放仓库。
- 在 GitHub Secrets 保存（Base64 + 密码）。
- 每年轮换并记录生效日期。

---

## 2. 当前仓库已落地的脚本

已新增：
- `scripts/signing/sign-artifacts.ps1`
- `scripts/signing/verify-signatures.ps1`
- `.github/workflows/windows-signed-release.yml`

并新增 npm 脚本：
- `npm run dist:unsigned`
- `npm run dist:unsigned:x64`
- `npm run dist:unsigned:arm64`
- `npm run sign:artifacts`
- `npm run verify:signatures`

---

## 3. 本地签名流程（手动）

### 3.1 准备环境变量

```powershell
$env:WIN_CERT_PATH = "C:\secrets\codesign.pfx"
$env:WIN_CERT_PASSWORD = "你的证书密码"
```

### 3.2 构建 + 签名 + 验签

```powershell
npm ci
npm run dist:unsigned:x64
npm run sign:artifacts
npm run verify:signatures
```

---

## 4. GitHub Actions 自动签名发布（推荐）

工作流：`.github/workflows/windows-signed-release.yml`

需要配置仓库 Secrets：
- `WIN_CERT_PFX_BASE64`：`pfx` 文件的 Base64 文本
- `WIN_CERT_PASSWORD`：`pfx` 密码

触发方式：
1. 打开 Actions
2. 运行 `windows-signed-release`
3. 填写：
   - `tag_name`（如 `v25.0417.1`）
   - `release_name`（如 `BookGet GUI Windows 25.0417.1`）

CI 会执行：
1. 构建 unsigned x64 包
2. 对产物签名
3. 验证签名
4. 上传 Release 附件

---

## 5. 签名范围建议

最低要求（当前脚本已覆盖）：
- `BookGet-GUI-Windows-Setup-*.exe`
- `BookGet-GUI-Windows-Portable-*.exe`
- `win-unpacked/*.exe`
- `win-arm64-unpacked/*.exe`

可选加强：
- 对 `dll` 一并签名（`sign-artifacts.ps1 -IncludeDlls`）

---

## 6. 发布前检查清单

- [ ] 版本号已更新（`package.json`）
- [ ] 核心依赖/`bookget-core.exe` 版本已确认
- [ ] `npm run verify:signatures` 通过
- [ ] VirusTotal 结果无高危误报（可选）
- [ ] Release 附件命名与架构一致

---

## 7. 常见问题

### Q1: 仍提示“Windows 无法访问”
- 检查是否下载了旧附件（浏览器缓存）。
- 检查 Release 附件时间是否最新。
- 确认验签通过：`signtool verify /pa /all /v xxx.exe`

### Q2: CI 报找不到 signtool
- `windows-latest` 通常自带；若异常可安装 Windows SDK。
- 或设置 `WIN_SIGNTOOL_PATH` 指向 `signtool.exe`。

### Q3: SmartScreen 仍告警
- 新证书初期信誉不足是正常现象。
- EV 证书通常改善更明显。

