# deepseek-Harness（本仓库分支）

> **一句话**：这不是 DeepSeek Harness 官方代码的副本，而是一份**在 Android 10+ / arm64 手机上把 DSH 跑起来**的完整构建分支。
> 上游内核保持原样不做业务改动，全部适配都在「壳」和「打完补丁的产物」这一层完成。

- 上游内核：`@deepseek-ai/dsh` **0.2.0-rc.2**
- 本分支产物：`1.20.0-dual-18-icon`（APK 见 Releases → `apk-18`）
- 目标设备（唯一验证过的）：BBK A2 / P22H190 / 展锐 T610 / Android 11 / arm64

---

## 一、这个分支多加了什么

分三块：**Android 壳**、**内核适配补丁**、**自研插件**。

### 1. Android 壳（`android-app/`，Java 源码合计 1,102,344 字节）

把 DSH 内核塞进一个原生 App 里，让它不再是只有桌面上能跑的几个命令行。

| 部件 | 作用 | 关键点 |
|---|---|---|
| `MainActivity.java` | 全部 UI 与编排（609,577 字节，单个文件——是历史选择，不是疏忽） | 内置 WebView 承载 DSH 的 Web 界面，外加一个可切换的原生终端 |
| `EngineService.java` | 前台服务跑 DSH 引擎 | 独立进程，随 App 启停 |
| `KernelSelfCheck.java` | 启动前自检 | payload 解压完整性、Node 可达性、端口占用 |
| **双引擎**（WebView / GeckoView） | **★本分支独有** | 见下方「双引擎」 |
| `AccessibilityService.java`（64 KB） | 屏幕助手：读控件树、点击、输入、滚动、截图 | 让 AI 能操作别的 App，不需要 root |
| `OverlayService.java`（59 KB） | 悬浮窗小鲸鱼 + 状态面板 | |
| `VsreenBridgeService.java` + `vscreen/` | **虚拟屏**：`createVirtualDisplay` 起一块独立屏，App 在里面跑，主屏不受影响 | 需要 root 或 Shizuku |
| `BrowserHost.java` / `BrowserService.java` / `BrowserIpc.java` | **AI 浏览器**：结构化 DOM 快照 + 稳定 ref | 不是截图 OCR，是读 DOM |
| `SessionAdmin.java` / `SessionHeal.java` | 会话增删与**会话修复** | 见下方「会话自愈」 |
| `ConsoleTheme.java`（61 KB） | 控制台主题渲染 | 配套 `console-theme/` 的 theme pack 规范 |
| `PayloadScript.java` | payload 解压与版本校验 | 支持增量更新，不每次全解 |
| `UserPatches.java` | 用户侧补丁管理 | 允许不改 payload 就能改配置 |
| `LogShareProvider.java` | 日志导出 | FileProvider |
| `LocalAuth.java` | 本机免登录令牌 | 局域网访问时仍要令牌 |
| `UsageStatsHelper.java` | 应用使用时长统计 | 喂给 `usage` 工具 |

#### ★ 双引擎（本分支最核心的改动）

| | 引擎 A | 引擎 B |
|---|---|---|
| 实现 | **系统 WebView** | **GeckoView**（Firefox 内核，内置整套 `.so`） |
| 选哪条 | WebView Chromium **≥ 94** | 不满足时自动切换，也可手动强制 |
| 体积 | 0（用系统的） | APK 内自带约 100 MB 原生库 |
| 解决的问题 | 老设备系统 WebView 太旧，新版前端直接白屏 | 旧 WebView 上**仍能跑**，代价是体积 |

判定用的是 `WebViewCompat.getCurrentWebViewPackage()` 取版本号，**不猜设备型号**。
所以你换一台旧手机装同一个 APK，它会自己落到 Gecko 上。

### 2. 内核适配补丁（`cordis.patch.yml` + 一批本地实现）

DSH 内核本身没改，**全部通过插件表 patch 生效**：

| 补丁 | 替换掉 | 为什么 Android 上不行 |
|---|---|---|
| `bash-local` / `bash-sandbox` | 官方 `bash-sandbox` | 官方那套要 `node-pty` 原生模块 + koffi，Android 上没有可用的预编译产物 |
| `attachment-local` | 官方 `attachment-local` 的 sharp 分支 | sharp 是原生库，改成**纯 JS 头解析**（`sharp-shim.js`），只取尺寸/格式不重编码 |
| `subprocess-local` | 官方版本 | `node-pty` → `child_process`，koffi 改惰性加载 |
| `session-persistence-jsonl` | 官方版本 | `link()` 在 F2FS/exFAT sdcard 上行为不一致，改成 `rename()` |
| `sandbox` | **保持启用** | 见下方踩坑记录，禁了会连会话都建不起来 |
| `pwsh-sandbox` | 禁用 | Android 没有 pwsh |
| `session-telemetry-otel` | 禁用 | 不上报遥测，同时砍掉整套 `@opentelemetry`（省一大块体积） |
| `session-log-download` | 禁用 | 移动端用不上 |

#### ★ 会话自愈（`session-heal.mjs` / `SessionHeal.java`）

这是**踩出来的**，不是设计出来的。

DSH 的一个会话靠**三条记录**绑定工作区：

```
① workspace.json 里的路径
② 会话目录名（路径转义后的形式）
③ 首帧 header.cwd
```

**三条任何一条对不上** → 引擎报 `corrupt session log` → **整个会话登记表加载失败** → **所有会话从界面消失**。
不是丢数据，是「一条坏，全盘不可见」。

自愈工具做的事：比对三条记录、按需改写、把日志从单帧改写成多帧（zstd 多帧，每帧一次活动）。
**它在救回被误标坏的会话时救回过整份 66 个会话的列表。**

### 3. 插件（★分两种来源，别混）

#### 3a. 自研插件（本项目原创）

只有一个：

| 包名 | 版本 | 作用 |
|---|---|---|
| `@local/dsh-net` | 1.0.0 | 联网工具。**不用代理**——刻意只用国内能直连的接口（`api.github.com` 通、`github.com` 主站超时） |

**提供的 11 个工具**

| 工具 | 干什么 |
|---|---|
| `web_search_bing` | 必应搜网页（本机唯一可用的通用搜索） |
| `repo_search` | 按关键词搜 GitHub 仓库 |
| `repo_files` | 列仓库目录 / 读文件真实内容 |
| `repo_commits` | 看提交历史 |
| `repo_download` | 下任意直链文件 |
| `web_fetch_text` | 抓网页剥标签给正文 |
| `bilibili_search` | 搜 B 站视频 |
| `net_keystore` | 读写持久化密钥 |
| `net_sensitive_stats` | 看敏感词库统计（不返回词本身） |
| `net_add_sensitive` | 加一个敏感词 / 屏蔽一个域名 |
| `dialog_snapshot` / `dialog_rollback` | 对话快照与回滚 |

**源码不在本仓库**，在 `files/net-plugin/`：
`index.js`（57,821 B，主体）/ `denoise.js`（搜索结果去噪）/ `sensitive.js`（敏感词过滤）/ `bilibili.js`。

#### 3b. 第三方 npm 包（★不是本仓库成果）

| 包名 | 版本 | 作用 |
|---|---|---|
| `meow-memory` | ^0.31.1 | 跨会话记忆，七层 SQLite（soul/user/project/fact/lesson/topic/rules），按关键词检索后注入 |
| `dsh-remedy` | ^0.4.20 | 修流式响应里的 `MALFORMED_RESPONSE`——把粘连的 tool-call arguments 拆开 |

装载方式（`profiles/web/package.json`）：

```json
"dependencies": {
  "@deepseek-ai/schemastery": "^3.18.5",
  "@local/dsh-net": "link:/.../net-plugin",
  "meow-memory": "^0.31.1",
  "dsh-remedy": "^0.4.20"
},
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@deepseek-ai/dsh-experimental-agent-team-profile",
      "meow-memory",
      "dsh-remedy"
    ],
    "patchReload": "live"
  }
}
```

### ★★重要：APK 里一个插件都没有

打开 APK 的 `assets/payload.zip` 逐项看过，实际内容是：

```json
// profiles/web/package.json
"dependencies": {},
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
```

```yaml
# cordis.patch.yml 的 insert，只有 6 项
bash-local / tool-shizuku / tool-android / tool-accessibility / tool-vscreen / tool-browser
# ★没有 net，没有 meow-memory，没有 remedy
```

**也就是说：装完 = 一个裸壳。没有跨会话记忆、没有联网搜索、没有流式修复。**

上面 3a / 3b 的插件都要自己挂，方法见 `cordis.patch.yml` 里的 insert 写法，
或者参考 profile 的 `package.json` + `pnpm install` + `cordis.patch.yml` 三段式。

**另**：这些包和 `payload/`、`_gvmin/` 都没进 git。仓库里只有壳源码和构建脚本。

---

## 二、构建

`.github/workflows/build.yml`（10.7 KB）负责全部流程：

```
① 拉 @deepseek-ai/dsh@0.2.0-rc.2 到 payload/dshroot
② pnpm install（★必须 pnpm，npm 会重算依赖树把未声明包剪掉——踩过）
③ 应用 cordis.patch.yml
④ 装 GeckoView 原生库（_gvmin/）
⑤ build.sh：javac → d8 → aapt2 → zipalign → a2apksig（纯 Node 签名，不依赖 apksigner）
⑥ 产出两个 APK：单引擎版、双引擎版
```

**签名工具是本仓库自己写的**（`android-app/sign/` + a2apksig）：v1 JAR 签名 + v2 AOSP 两层分块摘要，
纯 Node 实现，因为 CI 环境里不想拖 JDK 的 `apksigner`。`sign/testkey.pk8` 只是**构建测试用**的，
不要在真机上信任它。

---

## 三、已知限制

| 限制 | 说明 |
|---|---|
| **只验证过一台机器** | BBK A2 / P22H190 / Android 11 / arm64。其他机型没跑过，别当承诺 |
| **Android 10+ 才支持** | 依赖 `createVirtualDisplay` 和 WebView 版本探测 |
| **Gecko 版 APK 很大** | 约 250 MB（双引擎）/ 单引擎版小很多 |
| `MainActivity.java` 60.9 万字节 | 单文件，改起来很痛苦，是历史债，没重构 |
| **没有 CI 缓存** | 每次构建都要重新拉 payload，约 228 MB |
| **不提供自动更新** | 手动换 APK |
| **★APK 里没有插件** | 装完是裸壳：没有跨会话记忆、没有联网、没有流式修复。三个插件要自己挂，见 3a / 3b |
| **★重装要重来一遍** | 挂插件、授超级用户、授悬浮窗，这些都不在 APK 里。更新 APK 会把 payload/ 整个覆盖 |

---

## 四、安装

- **用什么装都行** —— MT 管理器、pm install、Shizuku、adb，能装上就用
- **签名** —— AOSP 公开 testkey（CN=Android），没有私钥门槛
- **★装完不是成品** —— 插件和权限要自己补，见「三、已知限制」

---

## 五、安全与隐私

- **不联网上报**：遥测插件已禁用
- **无任何激活码 / 账号体系**：装完即用
- **权限是可选的**：无障碍、悬浮窗、使用情况访问、Shizuku/root，**不授权也能用主体功能**（只是少了屏幕操作、虚拟屏这些）
- **root/Shizuku 是可选路径**：不授权时引擎仍可启动，只是 `shizuku_shell` 之类工具不可用

---

## 六、Releases

| Tag | 内容 |
|---|---|
| `apk-18` | 当前版本 `1.20.0-dual-18-icon`，双引擎（WebView + GeckoView），自定义图标。资产 `DeepSeekHarness-1.20.0-dual-18.apk`，253,300,073 字节 |

**下载前请核对 sha256。** 同一份代码不同 CI 跑出来字节数可能差几 KB（版本字符串里带构建时间），
大小一样不代表同一个包，一定要比 sha256。

---

## 七、上游

本分支不修改 DSH 内核（`@deepseek-ai/dsh`）的任何业务代码。
内核问题请回到上游仓库报；壳层/Android 适配问题在这里报。

---

## 八、许可

跟随上游。`android-app/` 和 `console-theme/` 里的原创部分同样跟随上游许可。
`sign/testkey.*` 是构建测试密钥，**没有任何安全意义**。
