# Desk mobile (Capacitor)

Android/iOS 外壳。它只做一件事：记住你的 Desk Hub 地址，然后把 Hub 自己的 UI 加载到 WebView 里。

完整说明（三条路径、签名、CI、上架风险）在 [../docs/BUILD-MOBILE.md](../docs/BUILD-MOBILE.md)。

## 跑起来

```bash
cd mobile
npm ci                  # 安装 Capacitor
npm run sync:www        # ../public -> mobile/www（启动器 + UI 副本）
npx cap sync            # 同步到 android/ 和 ios/
```

- Android：`npm run build:android:debug`（需要 JDK 17 + Android SDK），或 Android Studio 打开 `android/`
- iOS：`cd ios/App && pod install && open App.xcworkspace`（只能在 macOS 上）
- 只改 UI：重跑 `npm run sync:www && npx cap sync`。**不要手改 `www/`**，它每次都会被重建（`shell/` 是源码）

## 指向一个 Hub

1. 电脑上启动 Hub，且允许局域网访问：
   ```bash
   ASSIST_ALLOW_REMOTE=1 HOST=0.0.0.0 npm start
   ```
   终端会打印 `LAN URL: http://192.168.x.x:4390` 和 `pairing code: <8 位>`。
2. 手机 App 首次打开：填 `http://192.168.x.x:4390`，配对码可填可不填 → 「连接并打开」。
3. 之后每次启动会停在启动器（显示 Hub + 在线状态），点「打开 Desk」进入。
4. 换 Hub：
   - Android：在 Desk 里按**返回键** → 回到启动器 → 「更换 Hub」
   - iOS：**退出 App 再打开**（启动器永远是启动页）
5. 地址存在 `@capacitor/preferences`（key `desk.hubUrl`）；配对凭证是 Hub 侧的 `HttpOnly` cookie，App 不持有、也读不到。原因见 BUILD-MOBILE.md §0。

## 版本

- 外壳（`mobile/package.json` 的 `version`）只影响启动器页脚与 `www/shell-info.json`。
- Android 版本：`android/app/build.gradle` 读 `DESK_VERSION_CODE` / `DESK_VERSION_NAME`，缺省 `1` / `1.0`；CI 用 `github.run_number` 当 versionCode。
- iOS 版本：Xcode 的 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`（或 `agvtool`）。
- App 与 UI 是分开的：UI 在电脑上，App 每次打开拿到的都是电脑上**当前**那份界面——所以改 UI 不需要重新发版。

## 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run sync:www` | 重建 `www/`（启动器 + `public/` 副本 + `shell-info.json`） |
| `npm run sync` | `sync:www` + `cap sync` |
| `npm run build:android:debug` | `sync` + `./gradlew assembleDebug` |
| `npm run build:android:release` | `sync` + `./gradlew assembleRelease`（签名读 `DESK_*` 环境变量，缺了就出 unsigned） |
| `npm run verify:yaml` | 解析 `.github/workflows/*.yml` 并检查结构 |
