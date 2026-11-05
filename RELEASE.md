# Desk v1 · 发布说明

**日期**：2026-11-05
**版本**：1.0.0
**包名**：`desk-desktop` / `personal-assistant`

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `desktop/dist/Desk-Setup-1.0.0.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Desk`，建桌面/开始菜单快捷方式，可卸载 |
| 不想装 / 想放 U 盘 | `desktop/dist/Desk-Portable-1.0.0.exe` | 免安装，双击即用（每次解压到临时目录） |
| 手机用 | 浏览器打开电脑上的地址 + 配对码 | 见下"手机"一节 |

两个 exe 都是 **79 MB**，都是 **未签名**（首次运行 SmartScreen 提示"未知发布者" → 更多信息 → 仍要运行）。

---

## 第一次使用

1. 双击 `Desk.exe`（或安装后的快捷方式）。窗口打开，右下角/顶栏显示 `mock · 演示`。
2. 点右上角 **⚙** → 填 **Provider**（OpenAI 兼容端点）、**Base URL**、**Model**、**API Key** → **保存** → **测试连接**。
   - DeepSeek：`https://api.deepseek.com/v1`，模型 `deepseek-chat`
   - OpenAI：`https://api.openai.com/v1`，模型 `gpt-4o-mini`
   - 本地 Ollama / vLLM：填你自己的 `http://127.0.0.1:11434/v1`
3. 回到对话，直接说话。工具调用会以 chip 形式出现在消息里，**高风险动作会停下来等你批准**。

数据在 `%APPDATA%\Desk\`（菜单 → "打开数据目录"）。卸载不会删它。

---

## 手机

1. 同一台电脑上，⚙ → **配对 · 手机访问** 里能看到局域网地址和 **8 位配对码**。
   - 如果显示的是 `127.0.0.1`，说明当前只监听本机。用下面的命令允许局域网：
   ```bat
   set ASSIST_ALLOW_REMOTE=1
   set HOST=0.0.0.0
   "C:\Users\<你>\AppData\Local\Programs\Desk\Desk.exe"
   ```
2. 手机浏览器打开 `http://<电脑局域网IP>:<端口>`，输入配对码 → 进入同一个工作台。
3. 想"装到主屏"：需要 https（局域网 http 不满足 secure context）。最省事是 Tailscale Serve 或 Cloudflare Tunnel 把端口转成 https，再"添加到主屏幕"。

**APK / IPA**：工程已就绪但没在本机构建（本机没有 JDK/Android SDK/Xcode）。

```bat
:: Android（需 JDK 17 + Android SDK）
cd mobile && npm ci && npm run sync:www && npx cap sync android
cd android && gradlew assembleDebug
:: => mobile\android\app\build\outputs\apk\debug\app-debug.apk
```

或者推到 GitHub 让 `.github/workflows/android.yml` 出包（Actions 页面下载 artifact `desk-android`）。iOS 走 `ios.yml`（macOS runner + 签名 Secrets），细则见 `docs/BUILD-MOBILE.md`。

---

## 这一版做到了什么

- **真模型流式**：逐字出字；mock 仍可离线演示。
- **多 Bot**：chief（协调）/ ops（命令）/ researcher（只读网页），可新建；Bot 之间能交接。
- **共享工作区**：所有 Bot 看同一份文件；写工作区外要审批。
- **记忆 / 技能 / 例程 / 审批**：四件套都在，例程支持 5 段 cron 与时区，无人值守遇高危会停下并通知而不是挂死。
- **手机配对**：8 位码 + HttpOnly cookie，5 次/分钟限速。
- **崩溃恢复**：待批卡与在飞回合落盘，重启后恢复。
- **桌面壳**：托盘、单实例、外链走系统浏览器、优雅关子进程。
- **PWA**：manifest + service worker + 图标，https 下可装主屏。

自测：`npm run smoke` → **199/199**（含流式解析、鉴权、配对、崩溃恢复的断言，全离线）。

---

## 这一版没做到什么

- **安装包未签名**：SmartScreen 会警告。正式分发需要 OV/EV 证书。
- **不是沙箱**：工作区外只是路径策略，shell denylist 是正则；审批防手滑，不防恶意模型。
- **浏览器工具还很浅**：`browser_open` 只取标题/URL，不能点、不能输入、不能截图。
- **远程访问是单密钥**：没有多用户/角色/吊销界面（删 `data/security.json` 重启即轮换）。暴露公网前请套隧道。
- **审批"可恢复"≠"可续跑"**：无人值守任务恢复后只记录决策，需要重跑。
- **记忆不压缩**：只追加，召回靠关键词+时间衰减。
- **APK/IPA 未构建**；Apple 4.2（最小功能）对纯 web 壳是硬风险。

---

## 目录

```
desktop/            Electron 壳 + electron-builder 配置 + 图标脚本
desktop/dist/       构建产物（安装包 / 免安装 / win-unpacked）
mobile/             Capacitor 工程（android/ + ios/ + 启动器）
.github/workflows/  Android APK / iOS IPA 的 CI
docs/               BUILD-WINDOWS.md · BUILD-MOBILE.md · 截图
public/             单文件 UI + PWA 资源
src/                后端（零依赖 Node）
scripts/smoke.mjs   199 条断言
```
