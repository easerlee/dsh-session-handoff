# dsh-handoff

上下文压力到阈值时，把当前工作**交接给一个新会话**。

## 它解决什么

长会话到后段会退化 —— 实测在 **~70% 上下文**时开始出现"只思考不输出"（`finish=stop` 但没有正文）。
DSH 原生的 compaction 是**就地压缩**（用摘要替换原文，历史被改写）；本插件提供另一条路：
**开新会话 + 一份可审阅的交接包**，旧会话原样保留。

## 与同类方案的差异

| 维度 | 社区同类（S3K926 的 dsh-session-switch） | 本插件 |
|---|---|---|
| 交接内容 | 依赖作者的**个人记忆档案**（日记/状态/生长） | **从会话自身机械提取**（改动过的文件、最近对话、停在哪儿） |
| 落点 | 记忆条目 | **写成文件** `工作区/.dsh/handoff/<时间戳>-<会话尾号>.md`，可审阅可追溯 |
| 触发 | 固定 65% | **真实上下文压力**（`contextPressure` 投影的 surfaceTokens/contextWindow），可配 |
| 依赖 | 需要 `dsh-auto-handoff`（**未发布**，装了也白装） | **单插件自洽** |
| 降级 | 依赖客户端切界面 | **不依赖**：新会话建好即返回 id 与标题 |
| 旧会话 | 自动归档 | **只改名加 ` [已交接]` 标记**，不归档不删除 |

## 装法

一个 DSH 插件 = 一个 npm 包（`main` + `dsh.bundle.patch`）+ 在活动 profile 里登记两处。

1. 把本仓库放到**任意目录**，但别放客户端安装目录里（升级/重装会被清掉）。
2. 活动 profile 目录（Windows：`C:\Users\<你>\.dsh\profiles\<名字>`）：
   - `package.json`：`dependencies` 加 `"dsh-handoff": "file:/绝对路径/dsh-handoff"`，
     并在 `dsh.profile.bundles` 数组里加 `"dsh-handoff"`；
   - `cordis.patch.yml`：加 `- id: dsh-handoff` 的配置块（见「配置」）。
3. 在 profile 目录里 `pnpm install`，把 `file:` 依赖链进来。
4. **重启 DSH** —— bundle 列表只在启动时读一次；改完源码同样要重启。

> 用 junction / symlink 装的时候，Node 按**真实路径**解析依赖，插件目录自己也必须能解析到
> `@deepseek-ai/*`。打包版（代码压在 `resources/app.asar` 里）还有额外一层坑，见文末「坑 2」。

## 配置

在 profile 的 `cordis.patch.yml` 里：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就只留 HTTP 接口，不做自动交接 |
| `thresholdRatio` | `0.85` | 压力到多少比例触发（0.85 = 85%） |
| `cooldownMs` | `300000` | 同一会话两次交接的最小间隔 |
| `handoffDir` | `.dsh/handoff` | 交接包落盘目录（相对工作区；写绝对路径也行） |
| `recentMessages` | `14` | 交接包里带多少条最近用户消息 |
| `maxChars` | `24000` | 交接包字数上限 |
| `renameOldSuffix` | ` [已交接]` | 旧会话改名时加的后缀 |
| `dryRun` | `false` | **true = 只生成交接包，不建新会话**（首次验证用） |

⚠️ patch 的 `config` 是**整段替换**，覆盖时必须把不想改的键一起写上。

## 怎么手动触发

### 桌面端：让 agent 调 `handoff_now` 工具（推荐）

DSH Desktop **拿不到 web token**（token 每次启动在内存里生成，磁盘上没有），所以 19387 那个
HTTP 口从外面进不去 —— 桌面端的手动触发走**工具**：

> 你：「帮我交接一下，换个新会话」
> agent：调 `handoff_now` → 返回新会话 id / 标题 / 交接包路径
>
> 第一次想先看交接包质量、不想真建会话：`handoff_now(dryRun: true)` —— 只落盘、不改名、不建会话。

也可以自己在工具面板里调。工具注册失败不影响 HTTP 接口和自动交接（只 warn）。

### 命令行 / dsh web：HTTP 接口

```bash
# 手动触发（不传 sessionId 就取最近一个活跃会话）
curl -X POST http://127.0.0.1:<端口>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"手动换会话"}'

# 看状态与上次结果
curl http://127.0.0.1:<端口>/api/handoff/status
```

Web 版地址栏里的 `?token=` 就是凭证；**桌面端没有地址栏**，只有开了 DevTools 才能从
`location.href` 里把它抠出来。

## 与 compaction 的关系（重要）

两件都开着，**阈值不同**：

| | 阈值 | 行为 |
|---|---|---|
| `compaction-basic` | **0.6** | 就地压缩，会话继续用 |
| `dsh-handoff` | **0.85** | 开新会话交接 |

→ compaction 会先把压力压到 0.6 以下，所以 **handoff 的自动触发基本不会发生**。
这是**故意的**：compaction 管日常，handoff 当安全网（compaction 失效时）+ 手动换新会话。

**想让 handoff 当主力**：把 `compaction-basic` 设回 `disabled: true`，
把 `dsh-handoff` 的 `thresholdRatio` 调到 `0.6`。

## 已知限制

1. **界面不会自动切** —— 新会话建好后返回 id 与标题，**需手动在会话列表里点过去**。
2. **交接包是机械提取，不是模型总结** —— 复杂任务可能不够精确。
3. 旧会话只改名不归档（有意）。

## ⚠️ 两个必须知道的坑（都踩过）

### 坑 1：junction 让 Node 按真实路径找依赖 — 但光挂 junction 还不够

插件用 junction 装在 profile 下，**Node 解析依赖按真实路径向上找**，所以
`import("@deepseek-ai/dsh-llm")` 会从 `E:\dsh-handoff` 往上找，不去 profile 找。
在插件目录挂 `node_modules` junction 是**必要**的，但**不够** —— 见坑 2。

### 坑 2：打包版的 `@deepseek-ai/*` 不在文件系统上（已修）

`E:\dsh` 是打包版，代码全在 `resources\app.asar` 里，所以
`@deepseek-ai/dsh-llm` **在磁盘上根本不存在**，裸 `import()` 必定：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm'
```

（实测：`dsh-better-sidebar` / `dsh-cost-meter` 在当前环境下就是这样 `failed to import` 的。）

**修法**（已在 `lib/index.js` 的 `resolveCreateUserMessage()` 里实现）：先试裸 import，
失败则用 `createRequire(process.argv[1])`（harness 入口）解析出 asar 内真实路径，
再 `import(pathToFileURL(路径))` —— Electron 的 fs 读得到 asar 内的文件，实测可行。

自检（**必须用 Electron 运行时**，普通 node 跑必失败，那是环境不对不是插件坏）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "E:\dsh\DeepSeek Harness.exe" "E:\dsh-handoff\selfcheck.mjs"
```

### 坑 3：路径含空格被截断（已修）

`E:/The Paradise Protocol/...` 按空格硬切会变 `E:/The`。分词器已改成引号内整体算一个 token。

## 验证状态（2026-10-01，新打包版 E:\dsh）

| 项 | 方式 | 结果 |
|---|---|---|
| 模块加载 / 导出 | Electron 运行时 import | ✅ |
| profile 组装（patch 生效、无未知 id） | 同构 profile 副本 `--dump-config` | ✅ `thresholdRatio: 0.85` |
| 挂载 + 路由 `/api/handoff/status` | 真 harness 实例 HTTP | ✅ 200，config 与 patch 一致 |
| **`@deepseek-ai/dsh-llm` 解析** | Electron 运行时 selfcheck | ✅ 拿到 `createUserMessage`，产出 `{content,source,role,id}` |
| **`handoff_now` 工具定义 / execute / 输出契约** | Electron 运行时 selfcheck | ✅ |
| 交接包生成 / 阈值判断 | 假 ctx（旧版） | ✅ |
| **真建新会话** | 活动实例里调 `handoff_now` | ✅ 2026-10-01 02:23，新会话 `session-298d5a39`，交接包 8851 字 / 63 个文件 |
| **标题读取** | 同一次真跑暴露 | ✅ 已修：改用 `ctx.sessionTitle.get()`；原先读 `session.title` 得空串。API 已用探针确认存在（`SessionTitleService.prototype` 有 `get`/`rename`），selfcheck 现在也钉住这条 |
| **新会话标题里的时间** | selfcheck | ✅ 本地 `HH-MM`（原先用 UTC：本地 02:23 会写成「接 18-23」） |
| 界面自动切换 | — | ❌ 不做（见「已知限制」） |

### 真跑暴露过的两个 bug（都已修，并写进了 selfcheck）

1. **`handoff_now` 的 `dryRun` 不生效**：`apply` 里转发给工具的那个 lambda 只接了 3 个参数，
   第 4 个 `dryRun` 被吞掉 —— 于是 `dryRun: true` 也真建了会话。
   selfcheck 现在会用假 ctx 真跑一遍 `apply`，再调**注册出来的那个工具**，专抓这类接线 bug。
2. **`titleOf()` 读不到标题**：这个版本的标题存在投影里，`session.title` 是空的。后果是新会话
   标题退化成「会话交接（接 HH-MM）」，旧会话也不会被加 ` [已交接]`（改名那段的条件是
   `oldTitle !== ''`）。已改用 `ctx.sessionTitle.get(session)`。

自检命令（改完插件代码先跑这个）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "E:\dsh\DeepSeek Harness.exe" "E:\dsh-handoff\selfcheck.mjs"
```
