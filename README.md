# dsh-session-handoff

[English](README.en.md) | 中文

DSH 插件：上下文压力到阈值时，把当前工作**交接给一个新会话**。

长会话到后段会退化（作者自测：约 70% 上下文后开始出现「只思考不输出」）。DSH 原生的 compaction 是
**就地压缩**——用摘要替换原文，历史被改写。本插件走另一条路：**开一个新会话 + 一份可审阅的
交接包**，旧会话原样留着。

- 按**真实上下文压力**触发，或按**本会话已被压缩的次数**触发（不是猜轮数）
- 交接包**从会话自身机械提取**（改动过的文件、最近几轮用户+助手消息、停在哪儿），落盘可审阅
- 桌面端 `handoff_now` 工具（支持 `dryRun` 试跑）/ web 端与命令行走 HTTP 接口
- 新会话建好后**界面自动切过去**（走 harness 的 `uiWorkspace.openSession`；web / 桌面端）
- 旧会话**只改名加 ` [已交接]`**，不归档不删除

## 安装

### 桌面端（profile `desktop`）

```cmd
"<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-session-handoff
```

- `desktop` 是 Electron 保留的 profile，**只能用它自己那套内置命令**。别处装的 npm CLI 会直接拒绝：
  `error: profile "desktop" is managed exclusively by the Electron application`
- 先**打开过一次桌面端**（profile 才会被初始化），执行前**完全退出**它 —— profile 有写锁，不退出会一直等
- 桌面端 `$DSH_HOME` 默认是 `%USERPROFILE%\.dsh`，profile 目录即 `%USERPROFILE%\.dsh\profiles\desktop`

### web 端（profile `web`）

```bash
dsh plugin --profile web add dsh-session-handoff
```

- `web` profile **首次使用时自动初始化**，不用手工建；目录是 `$DSH_HOME/profiles/web`
- web 端跑在独立 home 时（启动脚本里设了 `DSH_HOME`），要用**那一套**的 `dsh`/`dsh.cmd`，
  否则会装进另一个 home

### 两端都一样的地方

装完**重启对应的那一端**——bundle 列表只在启动时读一次。其余：

- npm 包名是 `dsh-session-handoff`（`dsh-handoff` 这个名字已被另一个插件占用）
- 一条命令会同时把包写进 profile 的 `dependencies` 和 `dsh.profile.bundles`，不用手动改文件
- 不走 npm 也行：`add github:easerlee/dsh-session-handoff`（同样的代码，只是每次装都拉仓库）

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

满足任一条件、且距上次交接超过 `cooldownMs` 就自动交接：

- 压力到 `thresholdRatio`
- **本会话已被压缩 `maxCompactions` 次**（默认 2）

第二个条件是必需的：compaction 每次都会把压力压回它自己的阈值以下，只看压力的话交接等不到触发点。
两边怎么配合，见下。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-session-handoff
  config:
    enabled: true
    thresholdRatio: 0.85     # 出厂默认 0.6；与 compaction 一起用时调高
    maxCompactions: 2        # 本会话被 compaction 压过几次就交接（0 = 只看压力）
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
| `maxCompactions` | `2` | 本会话被 compaction 压过几次就触发交接（`0` = 只看压力） |
| `cooldownMs` | `300000` | 同一会话两次交接的最小间隔 |
| `handoffDir` | `.dsh/handoff` | 交接包落盘目录（相对工作区；写绝对路径也行） |
| `recentMessages` | `14` | 用户消息段最多带多少条（每条截 400 字） |
| `maxChars` | `24000` | 交接包字数上限；余量按预算分给两个消息窗口，塞不下先丢更早的 |
| `renameOldSuffix` | ` [已交接]` | 旧会话改名时加的后缀 |
| `dryRun` | `false` | **true = 只生成交接包，不建新会话**（首次验证用） |

⚠️ patch 的 `config` 是**整段替换**，覆盖时必须把不想改的键一起写上。

助手消息段没有单独的条数配置：它吃用户消息段之后剩下的预算，**从最新往回填**，每条最多 600 字；
预算不够时丢掉的永远是更早的消息，最新的那条一定在（它就是「停在哪儿」）。

## 与 compaction 的关系

两个都开着时，**阈值不同**：

| | 阈值 | 行为 |
|---|---|---|
| `compaction-basic` | `0.6`（默认） | 就地压缩，会话继续用 |
| `dsh-session-handoff` | `0.85`（建议值，高于 compaction） | 开新会话交接 |

插件出厂默认也是 `0.6`，和 compaction 的默认阈值相同。两个都开着时，compaction 每次都会先把压力压回
自己的阈值以下，所以只看压力的话**交接等不到触发点**。交接因此还看压缩次数：本会话被压过
`maxCompactions` 次（默认 2）就换班——compaction 管日常，压够了就交出去。

想让 handoff 当主力（不看压缩次数、纯按压力交接）：把 `compaction-basic` 设回 `disabled: true`，
`maxCompactions` 设 `0`，`thresholdRatio` 保持默认的 `0.6`。

## 已知限制

1. **自动切会话需要 harness 提供导航接口**——走 `uiWorkspace.openSession`；该接口不存在时
   （较老的 harness）就不切，也不报错，`$DSH_HOME/handoff-client-report.json` 里会写明原因
2. **交接包是机械提取的原文摘录，不做模型总结**——近几轮的用户/助手消息、动过的文件、停在哪都会带上
   （助手消息里的决策句就是原始决策记录），但「哪条才是关键」要接手方自己判断
3. 旧会话只改名不归档（有意）
4. HTTP 接口只作用于**该宿主进程里活跃的会话**：刚起来、还没开过会话的实例会返回
   `没有可用会话（session 缺失）`
5. **另有一个同名插件**：同样叫 `dsh-session-handoff`，走源码/tarball 分发，靠 `/handoff` 手动触发、
   总结由模型生成；npm 上的这个名字是这份（带自动触发）

## License

MIT
