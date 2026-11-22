# @local/dsh-net — 外网工具插件

给智能体加上「查开源仓库、读代码、看提交历史、下文件、列账号全部仓库、搜必应、抓网页正文、搜B站、存密钥」等 **13 个工具**。
**不需要代理。** 搜索结果自带去噪，不会把股票/百科/音乐站那类污染结果一股脑灌进来。

## 为什么是这个组合

这台设备的网络是**国内直连**（实测）：翻墙类站点超时，但下面这些域名都能通：

| 目标 | 实测结果 |
|---|---|
| `api.github.com` | ✅ 200 |
| `raw.githubusercontent.com` | ✅ 200 |
| `registry.npmjs.org` | ✅ 200 |
| `cn.bing.com` | ✅ 200 |
| `github.com`（网页主站） | ❌ 超时 |
| `www.google.com` | ❌ 超时 |

所以插件**刻意只用了能通的接口**，不假装能访问被墙的站点。

## 十三个工具

| 工具 | 作用 | 例子 |
|---|---|---|
| `repo_search` | 按关键词搜 GitHub 仓库（可按语言/star 排序） | `query="web framework" language="go" sort="stars"` |
| `repo_files` | 列仓库目录；或读某个文件的**真实内容** | `repo="nodejs/node" path="package.json"` |
| `repo_commits` | 看最近提交（可限定 path / ref / author） | `repo="nodejs/node" path="lib/" limit=5` |
| `repo_download` | 下载任意直链文件到本地 | `url="https://raw.githubusercontent.com/.../README.md"` |
| `web_search_bing` | 用 Bing 搜网页并解析结果 | `query="DeepSeek Harness 插件"` |
| `web_fetch_text` | 抓一页网页，剥掉标签给正文 | `url="https://..." maxChars=20000` |
| `bilibili_search` | 搜B站视频，**拿得到 BV 号**（看得到标题简介，看不到视频内容） | `query="步步高刷机" limit=10` |
| `repo_owner_repos` | **一次列出某账号的全部仓库**（比反复换词搜强得多） | `owner="rtyutechstudio"` |
| `net_keystore` | 密钥持久化：list / get / set / unset | `action="set" key="github" value="ghp_..."` |
| `net_sensitive_stats` / `net_add_sensitive` | 本地敏感词表：看统计 / 加一个词或域名 | `word="某词"` |
| `dialog_snapshot` / `dialog_rollback` | 对话快照与回滚 | `action="save"` |

`web_fetch_text` 和 `web_search_bing` 是配套的：先搜索拿 URL，再抓正文读细节。

## 已验证（真实网络，非模拟）

- 搜仓库 `deepseek harness` → 返回 22189 条，第一条是 `deepseek-ai/deepseek-harness ★251487`
- 列 `nodejs/node` 根目录 → 51 个条目，带文件大小
- 读 `deepseek-harness/package.json` → 取回完整 18994 字节内容
- 按分支读取 `nodejs/node/CHANGELOG.md@main` → 取回 54527 字节
- `repo_commits` 看 `nodejs/node` 最近 3 条提交 → 带 sha、日期、作者、标题
- `web_fetch_text` 抓 `example.com` → 提取标题 `Example Domain` 与正文
- `web_fetch_text` 抓 raw README → 42604 字符，截断标记正确
- Bing 搜索 → 解析出标题/URL/摘要
- 下载 raw 文件 → 落地 42695 字节，并给出内容预览

## 搜索结果去噪

中文专有名词一进搜索引擎就被污染，这个插件在返回结果前先过三道闸：

| 规则 | 做什么 | 例子 |
|---|---|---|
| 黑名单域名 | 命中即丢 | `quote.eastmoney.com`（股票）、`music.163.com`（同名歌曲）、`baike.baidu.com`（百科） |
| 关键词不相关 | 查询词的实词都没出现在标题/摘要/URL 里 → 判无关 | 搜「紫光展锐 T610」返回「紫光股份公司简介」 |
| 强污染词告警 | 查询词本身是高污染词时给出提示 | 搜「步步高」会提示改用 `eebbk` / `家教机` |

内置污染词表：`BBK`（默认指 vivo/OPPO 母公司）、`步步高`（零售集团/股票/歌曲）、`紫光`（紫光股份）、`小天才`。

配置里 `denoise: false` 可整体关掉；`blockedDomains` 可追加自定义黑名单。

## B站搜索

只取「看得到标题、看不到内容」那一层：标题、BV 号、UP 主、播放量、时长、发布日期、简介摘要、封面地址。
**不下载视频、不解析视频流、不取字幕。**

**关键坑**：`api.bilibili.com/x/web-interface/search/type` 直接请求一律 `412 request was banned`，
无论请求头仿得多像。必须**先访问一次主站拿 `buvid3` cookie**，再带着 cookie 搜，才返回 200。
模块内做了 30 分钟 cookie 缓存，避免每次搜索都多打一次主站。

## 密钥持久化

`net_keystore` 把密钥存到 `net-keystore.json`（权限 0600），**重启后依然有效**，不用每次翻记忆重填。

```
net_keystore(action="set",  key="github",   value="ghp_xxx")
net_keystore(action="list")                  # 只显示掩码，不显示原文
net_keystore(action="get",  key="github")
net_keystore(action="unset",key="github")
```

写入用「临时文件 + rename」的原子写，避免写一半崩了留下坏 JSON。

## 2026-11-22 的改动（针对「多词搜索 0 命中」）

**根因**：GitHub 的 `q` 参数把空格当 **AND** —— 放进多个词就要求它们同时出现。
`"步步高 内核 kernel"` 必然 0 命中，而 `"步步高内核"` 能命中 121 个。
**不是搜索结果少，是查询写法要求太严。**

三处改动：

1. **`repo_search` 0 结果时给诊断**，不再只说 `No repository matches`：
   区分「真 0 命中」「查询含空格是 AND」「限速」，并提示改成连写或单个尖词。
2. **`repo_search` 拆词回退 + 区分度阈值** `DISTINCTIVE_MAX = 60`：
   0 命中时把查询拆成单词逐个搜、合并结果，但**命中数 > 60 的词说明它没有筛选力，跳过并说明原因**。
   （第一版没有这道闸，把「微信框架 / MySQL 同步 / 爬虫」合并进来，比原来更糟 ——
    用看似有产出的结果掩盖「没命中」，比明确失败更危险。）
3. **新增 `repo_owner_repos`**：一次列出某账号全部仓库。
   实测 `rtyutechstudio` → 72 个仓库一次拿全；`filter` 不中时会说明「该账号共有 72 个，去掉 filter 再看」，
   不会让人误以为「这个人没有」。

另：`web_fetch_text` 增加 **SPA 检测** —— HTML 正文 < 400 字符时提示改用浏览器工具走真实渲染。

## 已知限制（如实说明）

- **GitHub 代码搜索不可用**：`api.github.com/search/code` 匿名返回 **401**，GraphQL 返回 **403**。插件不提供假功能。
- **匿名访问有速率限制**：约每分钟 10 次搜索。填 `token` 可提高上限。
- **被墙站点仍然打不开**：这是网络路径问题，插件解决不了，需要代理。
- `web_fetch_text` 用正则剥标签（本运行时无 DOM），个别奇形怪状的页面可能残留少量噪音；`raw: true` 可拿原始 HTML。

## 配置

```yaml
- id: net
  name: '@local/dsh-net'
  config:
    downloadDir: ''    # 下载目录；留空 = <工作目录>/downloads
    token: ''          # GitHub token（可选）
    timeoutMs: 20000   # 单次请求超时
    denoise: true      # 搜索结果去噪开关
    blockedDomains: [] # 追加黑名单；留空用内置默认表
```

## 手动安装

```bash
# 用 Plugin Manager，或直接让智能体执行：
# plugin_manager(action="install_bundle", target="<本目录的绝对路径>")
```

安装后**需要重启 Harness** 才能加载（DSH 对已安装包不做模块级热替换）。

## 卸载

```
plugin_manager(action="remove_bundle", target="@local/dsh-net")
```
