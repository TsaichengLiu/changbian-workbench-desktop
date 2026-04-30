# BookGet GUI (Windows)

基于 `bookget-25.0417.macOS-arm64-gui` 复刻的 Windows 桌面版工作台。

## 目标

- 兼容主流 Windows 系统（Windows 10/11，x64 与 arm64）。
- 复刻 macOS 版主要功能与操作链路：
  - 双栏单窗口下载工作台
  - 多网址队列、暂停/继续/终止
  - 实时日志与日志导出
  - 高级参数（`a/n/r/seq/vol/interval/ext/ua/cookie/localStorage`）
  - 需要登录/验证码时的弹窗浏览器流程
- 支持网站与 macOS 版一致：
  - 已从 macOS 源码 `supportedSites` 原样提取到 `src/supported-sites.json`
  - `bookget-core` 原生站点 + GUI/wrapper 专用站点

## 已实现的专用站点适配

- `digitalarchive.npm.gov.tw`
  - `Collection/Detail` 自动转 `Integrate/GetJson?cid=...` manifest 入口。
- `qingarchives.npm.edu.tw`
  - `Display/image|print` 入口自动解析页码并逐页下载。
- `gj.library.sh.cn` / `dhapi.library.sh.cn/pdfview`
  - 支持弹窗登录后继续，`pdfview` 入口走专用下载逻辑。
- `rbook.ncl.edu.tw`
  - `SearchDetail` 入口走弹窗抓页流程（进入阅读页后按 `F8` 启动抓页）。

## 弹窗浏览器操作

当前 Windows 版使用快捷键控制登录弹窗：

- `F8`：完成（登录成功后继续流程）
- `Esc`：取消当前任务

这对应 macOS 版“完成/取消”按钮语义。

## 目录结构

- `electron/main.cjs`：主进程、IPC、窗口、下载任务调度
- `electron/task-runner.cjs`：队列引擎、URL 预处理、专用站点适配
- `electron/preload.cjs`：主界面 bridge
- `electron/popup-preload.cjs`：登录弹窗提示层
- `src/index.html` + `src/styles.css` + `src/renderer.js`：GUI
- `src/supported-sites.json`：macOS 同步网站清单
- `resources/bin/`：运行时二进制（`bookget-core.exe` 等）

## 开发与打包

```bash
cd bookget-gui-windows
npm install
npm run start
```

Windows 打包：

```bash
npm run dist
```

产物输出在 `release/`（`nsis` 安装包 + `portable` 便携包）。

## 二进制准备

把以下文件放到 `resources/bin/`：

- `bookget-core.exe`（必需）
- `dezoomify-rs.exe`（推荐）

详见 `resources/bin/README.txt`。

## 说明

- 当前实现优先保证下载流程和站点适配行为一致，UI 视觉风格按 macOS 版工作台方向复刻。
- 如需进一步追平 macOS 的所有交互细节（例如弹窗里的按钮式导航栏和更细粒度状态提示），可在现有架构上继续增强。
