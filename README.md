# dsh-handoff

[English](README.en.md) | 中文

DSH 插件：上下文压力到阈值时，把当前工作**交接给一个新会话**。

长会话到后段会退化（实测约 70% 上下文后开始出现「只思考不输出」）。DSH 原生的 cleanup
compaction 是**就地压缩**——用摘要替换原文，历史被改写。这个插件走另一条路：
**开一个新会话 + 一份可审阅的交接包**，旧会话原样留着。

## 特性

- **按真实上下文压力触发**：读 `contextPressure` 投影的 `surfaceTokens / contextWindow`，
  不是猜轮数或消息条数
- **交接包从会话自身机械提取**：改动过的文件、最近用户消息、最后一条助手消息停在哪儿；
  写成文件落盘在 `<工作区>/.dsh/handoff/<时间戳>-<会话尾号>.md`，可审阅、可追溯
- **两个手动入口**：桌面端调 `handoff_now` 工具（支持 `dryRun` 试跑）；命令行 / dsh web 走 HTTP 接口
- **旧会话只改名加 ` [已交接]`**，不归档不删除
- **单插件自洽**：不依赖任何配套插件、不依赖个人记忆档案

## 装法

一个 DSH 插件 = 一个 npm 包（`main` + `dsh.bundle.patch`）+ 在活动 profile 里登记两处。

1. 把本仓库放到 DSH 自己的目录下，例如 `~/.dsh/plugins/dsh-handoff`
   （Windows：`C:\Users\<你>\.dsh\plugins\dsh-handoff`）——别放客户端安装目录里，升级/重装会被清掉。
2. 活动 profile 目录（Windows：`C:\Users\<你>\.dsh\profiles\<名字>`）：
   - `package.json`：`dependencies` 加 `"dsh-handoff": "file:/绝对路径/dsh-handoff"`，
     并在 `dsh.profile.bundles` 数组里加 `"dsh-handoff"`；
   - `cordis.patch.yml`：加「配置」一节里的那个块。
3. 在 profile 目录里 `pnpm install`，把 `file:` 依赖链进来。
4. **重启 DSH**——bundle 列表只在启动时读一次，改完源码同样要重启。

打包版（代码压在 `resources/app.asar` 里）无需额外配置：插件会自己从 harness 入口解析
`@deepseek-ai/*`。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-handoff
  config:
    enabled: true
    thresholdRatio: 0.85
    cooldownMs: 300000
    handoffDir: .dsh/handoff
    recentMessages: 14
    maxChars: 24000
    renameOldSuffix: " [已交接]"
    dryRun: false
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就只留 HTTP 接口与工具，不做自动交接 |
| `thresholdRatio` | `0.85` | 压力到多少比例触发（0.85 = 85%） |
| `cooldownMs` | `300000` | 同一会话两次交接的最小间隔 |
| `handoffDir` | `.dsh/handoff` | 交接包落盘目录（相对工作区；写绝对路径也行） |
| `recentMessages` | `14` | 交接包里带多少条最近用户消息 |
| `maxChars` | `24000` | 交接包字数上限 |
| `renameOldSuffix` | ` [已交接]` | 旧会话改名时加的后缀 |
| `dryRun` | `false` | **true = 只生成交接包，不建新会话**（首次验证用） |

⚠️ patch 的 `config` 是**整段替换**，覆盖时必须把不想改的键一起写上。

## 用法

### 桌面端：`handoff_now` 工具（推荐）

> 你：「帮我交接一下，换个新会话」
> agent：调 `handoff_now` → 返回新会话 id / 标题 / 交接包路径

第一次想先看交接包质量、不想真建会话：

```
handoff_now(dryRun: true)     # 只落盘，不建会话、不改旧会话名
```

### 命令行 / dsh web：HTTP 接口

```bash
# 手动触发（不传 sessionId 就取最近一个活跃会话）
curl -X POST http://127.0.0.1:<端口>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"手动换会话"}'

# 状态与上次结果
curl http://127.0.0.1:<端口>/api/handoff/status
```

Web 版地址栏里的 `?token=` 就是凭证；桌面端没有地址栏，只能开 DevTools 从 `location.href` 里抠。

### 自动触发

压力到 `thresholdRatio` 且距上次交接超过 `cooldownMs` 就自动交接——但先看下一节。

## 与 compaction 的关系

两个都开着时，**阈值不同**：

| | 阈值 | 行为 |
|---|---|---|
| `compaction-basic` | `0.6` | 就地压缩，会话继续用 |
| `dsh-handoff` | `0.85` | 开新会话交接 |

compaction 会先把压力压到 0.6 以下，所以 **handoff 的自动触发基本不会发生**。这是有意的：
compaction 管日常，handoff 当安全网 + 手动换新会话。

想让 handoff 当主力：把 `compaction-basic` 设回 `disabled: true`，把 `thresholdRatio` 调到 `0.6`。

## 已知限制

1. **界面不会自动切**——新会话建好后返回 id 与标题，需手动在会话列表里点过去
2. **交接包是机械提取，不是模型总结**——复杂任务可能不够精确
3. 旧会话只改名不归档（有意）

## 开发

```powershell
# 自检：真跑一遍 apply、注册出来的 handoff_now 工具、dryRun 分支和交接包落盘
$env:ELECTRON_RUN_AS_NODE=1
& "<DSH 安装目录>\DeepSeek Harness.exe" "<本仓库>\selfcheck.mjs"
```

必须用 Electron 运行时跑——打包版把 `@deepseek-ai/*` 放在 `app.asar` 里，普通 node 解不出来。

## License

MIT
