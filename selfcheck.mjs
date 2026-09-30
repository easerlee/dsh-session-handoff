/**
 * dsh-handoff 自检：只验最容易坏的地方 ——
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
 *   & "E:\dsh\DeepSeek Harness.exe" "E:\dsh-handoff\selfcheck.mjs"
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

  if (mod.name !== 'dsh-handoff') throw new Error('name 不对：' + mod.name)
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
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-handoff-selfcheck-'))
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
  const session = { id: 'session-selftest-0000', snapshotEvents: () => [] }
  const wired = await registered.execute({ reason: '接线自检', dryRun: true }, { agent: { session }, cwd: outDir })
  checkKeys(wired, '假 ctx 试跑')
  if (wired.ok !== true || wired.dryRun !== true) throw new Error('假 ctx 试跑没走 dryRun 分支（十有八九是实现里没把参数传下去）：' + JSON.stringify(wired))
  if (!existsSync(wired.filePath)) throw new Error('交接包没落盘：' + wired.filePath)
  const body = readFileSync(wired.filePath, 'utf8')
  if (!body.startsWith('# 交接包')) throw new Error('交接包内容不对')
  if (!/接线自检/.test(body)) throw new Error('交接包没带上 reason')
  if (wired.newTitle.indexOf('自检标题') !== 0) throw new Error('标题没从 sessionTitle.get() 的 snapshot.title 读到（旧会话也就不会被加 [已交接]）：' + wired.newTitle)
  if (!/^自检标题（接 \d{2}-\d{2}）$/.test(wired.newTitle)) throw new Error('标题没剥掉上一轮的「（接 HH-MM）」或时间戳不是本地 HH-MM：' + wired.newTitle)
  console.log('假 ctx 试跑 ok: ' + wired.filePath + '（' + body.length + ' 字），新标题「' + wired.newTitle + '」')
  rmSync(outDir, { recursive: true, force: true })

  console.log('SELFCHECK OK（argv[1]= ' + process.argv[1] + '）')
} catch (error) {
  console.error('SELFCHECK FAILED: ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
}
