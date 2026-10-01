# dsh-handoff

[English](README.en.md) | 中文

DSH 插件：上下文压力到阈值时，把当前工作**交接给一个新会话**。

长会话到后段会退化（作者自测：约 70% 上下文后开始出现「只思考不输出」）。DSH 原生的 compaction 是
**就地压缩**——用摘要替换原文，历史被改写。本插件走另一条路：**开一个新会话 + 一份可审阅的
交接包**，旧会话原样留着。

- 按**真实上下文压力**触发，不是猜轮数
- 交接包**从会话自身机械提取**（改动过的文件、最近消息、停在哪儿），落盘可审阅
- 桌面端 `handoff_now` 工具（支持 `dryRun` 试跑）/ web 端与命令行走 HTTP 接口
- 旧会话**只改名加 ` [已交接]`**，不归档不删除

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-session-handoff
```

装完**重启 DSH**——bundle 列表只在启动时读一次。

- npm 包名是 `dsh-session-handoff`（`dsh-handoff` 已被另一个插件占用），仓库仍叫 dsh-handoff
- 桌面端的 profile 是 `desktop`，web 端是 `web`；一条命令会同时把包写进 `dependencies` 和
  `dsh.profile.bundles`，不用手动改文件
- `dsh` 不在 PATH 上时，用它安装目录里的 `resources\runtime\cli\bin\dsh.cmd`
- 不走 npm 也行：`add github:easerlee/dsh-session-handoff`（同样的代码，只是每次装都拉仓库）
- **改本地源码**用 `add link:/绝对路径/dsh-handoff`：`file:` 会被 pnpm 复制成快照，之后改源码不生效

确认挂上了（web 端 / 命令行）：

```bash
curl "http://127.0.0.1:<端口>/api/handoff/status"
# {"ok":true,...,"tool":"registered"}   ← tool 为 registered 说明 handoff_now 工具也注册成功
```

## 用法

### 桌面端：`handoff_now` 工具（推荐）

> 你：「帮我交接一下，换个新会话」
> agent：调 `handoff_now` → 返回新会话 id / 标题 / 交接包路径

第一次想先看交接包质量、不想真建会话：

```
handoff_now(dryRun: true)     # 只落盘，不建会话、不改旧会话名
```

### web 端 / 命令行：HTTP 接口

```bash
# 手动触发（不传 sessionId 就取最近一个活跃会话）
curl -X POST http://127.0.0.1:<端口>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"手动换会话"}'

# 状态与上次结果
curl http://127.0.0.1:<端口>/api/handoff/status
```

`dsh web` 地址栏里的 `?token=` 是凭证（先访问一次 `/` 让 cookie 落下来，之后 API 才认）；桌面端
没有地址栏，手动触发走上面的工具。

### 自动触发

压力到 `thresholdRatio` 且距上次交接超过 `cooldownMs` 就自动交接——但先看「与 compaction 的关系」。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-handoff
  config:
    enabled: true
    thresholdRatio: 0.85     # 出厂默认 0.6；与 compaction 一起用时调高
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
| `thresholdRatio` | `0.6` | 压力到多少比例触发（0.6 = 60%）。与 compaction 一起用时调高，见下 |
| `cooldownMs` | `300000` | 同一会话两次交接的最小间隔 |
| `handoffDir` | `.dsh/handoff` | 交接包落盘目录（相对工作区；写绝对路径也行） |
| `recentMessages` | `14` | 交接包里带多少条最近用户消息 |
| `maxChars` | `24000` | 交接包字数上限 |
| `renameOldSuffix` | ` [已交接]` | 旧会话改名时加的后缀 |
| `dryRun` | `false` | **true = 只生成交接包，不建新会话**（首次验证用） |

⚠️ patch 的 `config` 是**整段替换**，覆盖时必须把不想改的键一起写上。

## 与 compaction 的关系

两个都开着时，**阈值不同**：

| | 阈值 | 行为 |
|---|---|---|
| `compaction-basic` | `0.6`（默认） | 就地压缩，会话继续用 |
| `dsh-handoff` | `0.85`（建议值，高于 compaction） | 开新会话交接 |

插件出厂默认也是 `0.6`，和 compaction 的默认阈值相同：两个的触发条件会同时满足，所以一起用时把
`thresholdRatio` 调高。

compaction 会先把压力压到 0.6 以下，所以 **handoff 的自动触发基本不会发生**。这是有意的：
compaction 管日常，handoff 当安全网 + 手动换新会话。

想让 handoff 当主力：把 `compaction-basic` 设回 `disabled: true`，`thresholdRatio` 保持默认的 `0.6` 就行。

## 已知限制

1. **界面不会自动切**——新会话建好后返回 id 与标题，需手动在会话列表里点过去
2. **交接包是机械提取，不是模型总结**——复杂任务可能不够精确
3. 旧会话只改名不归档（有意）
4. HTTP 接口只作用于**该宿主进程里活跃的会话**：刚起来、还没开过会话的实例会返回
   `没有可用会话（session 缺失）`

## 开发

改完源码先跑自检（真跑一遍 `apply`、注册出来的 `handoff_now` 工具、`dryRun` 分支和交接包落盘）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "<DSH 安装目录>\DeepSeek Harness.exe" "<本仓库>\selfcheck.mjs"
```

必须用 Electron 运行时跑——打包版把 `@deepseek-ai/*` 放在 `app.asar` 里，普通 node 解不出来。
插件在打包版下无需额外配置：它会自己从 harness 入口解析这些模块。

⚠️ **`link:` 装法下切换安装方式前，先解除链接**：pnpm 的 `remove` 可能沿 junction 删除，影响仓库自身的文件。
先断链，再 `add`：

```powershell
cmd /c rmdir "<profile 目录>\node_modules\dsh-session-handoff"
dsh plugin --profile <profile> add <新的装法>
```

## License

MIT
