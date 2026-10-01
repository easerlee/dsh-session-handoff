/**
 * dsh-session-handoff 自检：只验最容易坏的地方 ——
 *  1. 能不能拿到 @deepseek-ai/dsh-llm 的 createUserMessage（交接最后一步靠它）
 *  2. 能不能拿到 @deepseek-ai/dsh-tools 的 defineTool，并把 handoff_now 真正定义出来
 *  3. handoff_now 的 execute / 输出契约（六个键都在）、dryRun 分支、render 跑得通
 *  4. **apply 里注册工具那条线**：用假 ctx 真跑一次 apply，再调注册出来的那个工具
 *     （dryRun 只落盘、不建会话，所以假 ctx 够用）—— 这条专抓「参数没往下传」这类接线 bug
 *
 * 必须用 Electron 运行时跑：打包版把 @deepseek-ai/* 放在 app.asar 里，只有
 * Electron 的 fs 读得到。普通 node 跑必失败，那是环境不对，不是插件坏。
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "<DSH 安装目录>\DeepSeek Harness.exe" "<本仓库>\selfcheck.mjs"
 *
 * link: 装法下换装法之前先断链：pnpm 的 remove 可能沿 junction 删除，删到仓库自身的文件。
 *   cmd /c rmdir "<profile 目录>\node_modules\dsh-session-handoff"
 *   dsh plugin --profile <profile> add <新的装法>
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// 真跑的时候 argv[1] 是 harness 入口；独立跑时补上，让被测代码路径和线上一致。
const hostEntry = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
if (!/dsh-desktop-host/.test(String(process.argv[1] || ''))) process.argv[1] = hostEntry

const REQUIRED = ['ok', 'dryRun', 'newSessionId', 'newTitle', 'filePath', 'error']

function checkKeys(value, label) {
  for (const key of REQUIRED) {
    if (!(key in value)) throw new Error(label + ' 输出缺键 ' + key + '：' + JSON.stringify(value))
  }
}

try {
  const mod = await import(new URL('./lib/index.js', import.meta.url))

  if (mod.name !== 'dsh-session-handoff') throw new Error('name 不对：' + mod.name)
  if (typeof mod.apply !== 'function') throw new Error('apply 缺失')
  if (mod.apply.constructor.name !== 'AsyncFunction') throw new Error('apply 必须是 async（工具注册要 await）')
  if (!Array.isArray(mod.inject) || mod.inject.indexOf('tools') < 0) throw new Error('inject 缺 tools')

  const createUserMessage = await mod.loadCreateUserMessage()
  const message = createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })
  console.log('createUserMessage ok, message keys = ' + Object.keys(message).join(','))

  const defineTool = await mod.loadDefineTool()
  let seen = null
  const tool = defineTool(mod.handoffToolOptions(async (session, reason, cwd, dryRun) => {
    seen = { session, reason, cwd, dryRun }
    return dryRun
      ? { ok: true, dryRun: true, filePath: 'E:/x/handoff.md', newTitle: '标题（接 01:00）' }
      : { ok: true, newSessionId: 'session-fake', newTitle: '标题（接 01:00）', filePath: 'E:/x/handoff.md' }
  }))
  if (!tool || tool.name !== 'handoff_now') throw new Error('defineTool 返回不对：' + JSON.stringify(tool && tool.name))
  console.log('defineTool ok, keys = ' + Object.keys(tool).join(','))

  const exec = { agent: { session: { id: 'session-src' } }, cwd: 'E:/x' }

  const value = await tool.execute({ reason: '自检' }, exec)
  checkKeys(value, '真跑')
  if (value.ok !== true || value.dryRun !== false || value.newSessionId !== 'session-fake') throw new Error('真跑输出不对：' + JSON.stringify(value))
  if (!seen || seen.reason !== '自检' || seen.cwd !== 'E:/x' || !seen.session || seen.dryRun !== undefined) throw new Error('runOnce 入参不对：' + JSON.stringify(seen))
  const parts = tool.output.render({}, value)
  if (!Array.isArray(parts) || parts[0].type !== 'text' || !/^已交接/.test(parts[0].text)) throw new Error('真跑 render 不对：' + JSON.stringify(parts))
  console.log('真跑 ok: ' + parts[0].text.slice(0, 50))

  const dry = await tool.execute({ reason: '自检', dryRun: true }, exec)
  checkKeys(dry, '试跑')
  if (dry.ok !== true || dry.dryRun !== true || dry.newSessionId !== '') throw new Error('试跑输出不对：' + JSON.stringify(dry))
  if (!seen || seen.dryRun !== true) throw new Error('试跑没把 dryRun 传下去：' + JSON.stringify(seen))
  const dryParts = tool.output.render({}, dry)
  if (!/^试跑/.test(dryParts[0].text)) throw new Error('试跑 render 不对：' + dryParts[0].text)
  console.log('试跑 ok: ' + dryParts[0].text.slice(0, 50))

  const failed = tool.output.render({}, { ok: false, dryRun: false, newSessionId: '', newTitle: '', filePath: '', error: 'boom' })
  if (!/^交接失败/.test(failed[0].text)) throw new Error('失败 render 不对：' + failed[0].text)

  // ── 假 ctx 真跑 apply：验「注册出去的那个工具」的接线 ──────────────────────
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-session-handoff-selfcheck-'))
  let registered = null
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register() {} } },
    tools: { register(t) { registered = t } },
    on() {},
    // 标题只挂在会话日志的 session/title 事件上，session 对象里没有 —— 这条钉住读取路径。
    // 注意形状：get() 返回的是 snapshot 对象 { title, messageSeqs, source, eventSeq, updatedAt }，
    // 不是字符串（漏了 .title 就会静默掉回兜底标题，线上真出过一次）。带上一轮的「（接 ..）」
    // 是为了同时钉住"重复交接不叠时间戳"。
    sessionTitle: { get: () => ({ title: '自检标题（接 01-02）', messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 0 }) },
  }
  await mod.apply(ctx, { enabled: false, handoffDir: outDir })
  if (!registered || registered.name !== 'handoff_now') throw new Error('apply 没注册出 handoff_now 工具')
  const session = {
    id: 'session-selftest-0000',
    // 这两个 tool/call 专钉「文件清单里的垃圾条目」：引号包住的整条命令、写进文件里的散文、
    // <you>/$id 占位串、带空格的真路径 —— 全都在线上真出过一次。
    snapshotEvents: () => [
      { type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'Get-Item "E:/AO/ao-mcp-launcher.mjs 存在吗: "' } } },
      { type: 'tool/call', data: { name: 'write', arguments: { file_path: 'E:/Legend of Lhoba/NewProject/a.txt', content: '见 E:/dsh-session-handoff（工作区外），装到 C:/Users/<you>/.dsh/plugins/dsh-session-handoff。' } } },
    ],
  }
  const wired = await registered.execute({ reason: '接线自检', dryRun: true }, { agent: { session }, cwd: outDir })
  checkKeys(wired, '假 ctx 试跑')
  if (wired.ok !== true || wired.dryRun !== true) throw new Error('假 ctx 试跑没走 dryRun 分支（十有八九是实现里没把参数传下去）：' + JSON.stringify(wired))
  if (!existsSync(wired.filePath)) throw new Error('交接包没落盘：' + wired.filePath)
  const body = readFileSync(wired.filePath, 'utf8')
  if (!body.startsWith('# 交接包')) throw new Error('交接包内容不对')
  if (!/接线自检/.test(body)) throw new Error('交接包没带上 reason')
  if (wired.newTitle.indexOf('自检标题') !== 0) throw new Error('标题没从 sessionTitle.get() 的 snapshot.title 读到（旧会话也就不会被加 [已交接]）：' + wired.newTitle)
  if (!/^自检标题（接 \d{2}-\d{2}）$/.test(wired.newTitle)) throw new Error('标题没剥掉上一轮的「（接 HH-MM）」或时间戳不是本地 HH-MM：' + wired.newTitle)
  // 文件清单：真路径要在，垃圾条目一个都不能有
  const listed = (body.match(/## 改动过的文件[\s\S]*?(?=\n## )/) || [''])[0]
    .split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
  for (const want of ['E:/AO/ao-mcp-launcher.mjs', 'E:/Legend of Lhoba/NewProject/a.txt']) {
    if (listed.indexOf(want) < 0) throw new Error('文件清单漏了 ' + want + '：' + listed.join(' | '))
  }
  const dirty = listed.filter((p) => /[（），。；：！？<>$]|[\\/]$/.test(p))
  if (dirty.length > 0) throw new Error('文件清单里有垃圾条目：' + dirty.join(' | '))
  console.log('文件清单 ok: ' + listed.join(' | '))
  console.log('假 ctx 试跑 ok: ' + wired.filePath + '（' + body.length + ' 字），新标题「' + wired.newTitle + '」')

  // ── 空事件断言：读不到会话日志时必须失败，不许产出一份「全是（无）」的空壳包 ──
  const empty = await registered.execute({ reason: '空事件自检', dryRun: true }, { agent: { session: { id: 'session-empty', snapshotEvents: () => [] } }, cwd: outDir })
  checkKeys(empty, '空事件')
  if (empty.ok !== false) throw new Error('会话事件为空时没中止（会产出空壳交接包）：' + JSON.stringify(empty))
  if (empty.filePath !== '') throw new Error('空事件中止了却还是落了盘：' + empty.filePath)
  if (!/事件/.test(empty.error)) throw new Error('空事件的报错没说清原因：' + empty.error)
  console.log('空事件 ok: ' + empty.error)

  // ── 触发条件②：压力不达标、但会话已被压缩 ≥ maxCompactions 次时，必须自动交接 ──
  const triggerDir = mkdtempSync(join(tmpdir(), 'dsh-session-handoff-trigger-'))
  let preStep = null
  const routes = new Map()
  const triggerCtx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    tools: { register() {} },
    on(name, fn) { if (name === 'agent/pre-step') preStep = fn },
    sessionTitle: { get: () => undefined, rename() {} },
    // 压力远低于阈值 —— 唯一能触发的理由只剩「已压缩 2 次」
    sessionProjections: { stateOf: () => ({ surfaceTokens: 10, contextWindow: 1000 }) },
  }
  await mod.apply(triggerCtx, { enabled: true, dryRun: true, maxCompactions: 2, thresholdRatio: 0.99, handoffDir: triggerDir })
  if (!preStep) throw new Error('apply（enabled=true）没挂 agent/pre-step')
  const squeezed = {
    id: 'session-squeezed',
    snapshotEvents: () => [
      { type: 'compaction/summary', data: { summary: '第一次压缩' } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '原来的待办' }] } },
      { type: 'compaction/summary', data: { summary: '第二次压缩' } },
    ],
  }
  await preStep({ agent: { session: squeezed }, signal: { aborted: false } }, async () => {})
  const statusRoute = routes.get('/api/handoff/status')
  if (!statusRoute) throw new Error('apply 没注册 /api/handoff/status')
  let fired = null
  for (let i = 0; i < 60; i += 1) {
    const snap = await (await statusRoute.fetch()).json()
    if (snap.autoRuns > 0 && snap.lastResult) { fired = snap; break }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!fired) throw new Error('压过 2 次、压力不达标时没有触发自动交接')
  const auto = fired.lastResult
  if (auto.ok !== true || auto.dryRun !== true) throw new Error('自动交接结果不对：' + JSON.stringify(auto))
  if (auto.compactions !== 2) throw new Error('自动交接没数出 2 次压缩：' + JSON.stringify(auto.compactions))
  const squeezedBody = readFileSync(auto.filePath, 'utf8')
  if (!/已被压缩：2 次/.test(squeezedBody)) throw new Error('交接包没写压缩次数')
  if (!/触发原因：auto: 本会话已被压缩 2 次/.test(squeezedBody)) throw new Error('交接包的触发原因不是压缩次数：' + squeezedBody.split('\n')[3])
  console.log('压缩触发 ok: ' + squeezedBody.split('\n')[3] + ' → ' + auto.filePath)

  // ── 事件改名的静默失败：有 compaction/start、但一次 summary 都没数到 → 不许触发，且必须告警 ──
  const renamed = {
    id: 'session-renamed',
    snapshotEvents: () => [
      { type: 'compaction/start', data: {} },
      { type: 'user/message', data: { content: [{ type: 'text', text: '待办' }] } },
      { type: 'compaction/start', data: {} },
      { type: 'compaction/end', data: {} },
    ],
  }
  await preStep({ agent: { session: renamed }, signal: { aborted: false } }, async () => {})
  await new Promise((resolve) => setTimeout(resolve, 150))
  const renamedSnap = await (await statusRoute.fetch()).json()
  if (!renamedSnap.compaction || renamedSnap.compaction.sessionId !== 'session-renamed') throw new Error('status 没带压缩计数：' + JSON.stringify(renamedSnap.compaction))
  if (renamedSnap.compaction.summaries !== 0 || renamedSnap.compaction.starts !== 2) throw new Error('压缩计数不对：' + JSON.stringify(renamedSnap.compaction))
  if (!/改名|失效/.test(renamedSnap.warning || '')) throw new Error('压缩事件改名时没有告警（会静默退化成只看压力）：' + JSON.stringify(renamedSnap.warning))
  if (renamedSnap.autoRuns !== fired.autoRuns) throw new Error('压缩事件改名后仍然触发了交接：' + renamedSnap.autoRuns)
  console.log('改名告警 ok: ' + renamedSnap.warning)
  rmSync(triggerDir, { recursive: true, force: true })

  // ── 客户端半边：假 window + 假 fetch + 假 ctx，验「轮询 → 切到新会话」这条线 ──
  const clientCode = readFileSync(new URL('./client/open.js', import.meta.url), 'utf8')

  async function runClient(label, makeCtx, sessionId) {
    let clientModule = null
    const store = new Map()
    const timers = new Map()
    let nextTimer = 0
    const fakeWindow = {
      __ModuleLoader__: { load(spec) { clientModule = spec.factory(() => ({})) } },
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
      },
      setInterval: (fn) => { nextTimer += 1; timers.set(nextTimer, fn); return nextTimer },
      clearInterval: (id) => { timers.delete(id) },
      setTimeout: (fn, ms) => { setTimeout(fn, ms) },
    }
    const calls = []
    const fakeFetch = async (url) => {
      calls.push(String(url))
      if (String(url).includes('/api/handoff/status')) {
        return { ok: true, json: async () => ({ ok: true, lastResult: { ok: true, dryRun: false, newSessionId: sessionId } }) }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const opened = []
    new Function('window', 'fetch', 'console', 'setTimeout', clientCode)(fakeWindow, fakeFetch, console, setTimeout)
    if (clientModule === null) throw new Error(label + '：客户端模块没有调用 window.__ModuleLoader__.load')
    if (typeof clientModule.apply !== 'function') throw new Error(label + '：客户端模块没导出 apply')
    if (clientModule.inject.indexOf('sessions') < 0) throw new Error(label + '：客户端模块没有 inject sessions')
    const ctx = makeCtx(opened)
    // ctx.effect 按 cordis 语义：调用 setup，把返回的清理函数留存（apply 当场执行清理是 bug）。
    const cleanups = []
    ctx.effect = (setup) => { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup) }
    clientModule.apply(ctx)
    for (let i = 0; i < 60 && opened.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    if (opened.length !== 1 || opened[0] !== sessionId) throw new Error(label + '：没有切到新会话：' + JSON.stringify(opened))
    if (!calls.includes('/api/handoff/status')) throw new Error(label + '：没有轮询 /api/handoff/status')
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (!calls.includes('/api/handoff/client')) throw new Error(label + '：没有把结果回报给宿主')
    if (store.get('dsh-session-handoff.opened.v1:' + sessionId) !== '1') throw new Error(label + '：没记下「已切过」，下次会重复跳')
    if (timers.size === 0) throw new Error(label + '：apply 之后没有任何定时器在跑（清理函数是不是被当成 setup 执行了？）')
    console.log(label + ' ok: ' + sessionId + ' + 回报宿主')
  }

  // 首选路径：视图所有者的公开导航接口（官方 UiWorkspace.openSession），必须优先用它。
  await runClient('客户端首选 uiWorkspace.openSession', (opened) => ({
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => { opened.push(id) } }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { 'session-child-a': {} } }) } }
      return undefined
    },
  }), 'session-child-a')

  // 退回路径：只有 sessions.open（老版本形态），仍然要能切。
  await runClient('客户端退回 sessions.open', (opened) => ({
    sessions: { open: (id) => { opened.push(id) } },
  }), 'session-child-b')

  // 晚注册路径：apply 时 uiWorkspace 还不存在，靠 ctx.inject 等到它再开工。
  await runClient('客户端晚注册 uiWorkspace', (opened) => ({
    inject(deps, callback) {
      setTimeout(() => callback({ uiWorkspace: { openSession: (id) => { opened.push(id) } } }), 30)
    },
    get() { return undefined },
  }), 'session-child-c')



  rmSync(outDir, { recursive: true, force: true })

  console.log('SELFCHECK OK（argv[1]= ' + process.argv[1] + '）')
} catch (error) {
  console.error('SELFCHECK FAILED: ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
}
