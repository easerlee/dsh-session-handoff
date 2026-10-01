/**
 * dsh-session-handoff — web client（手写模块，无构建步骤）。
 *
 * 只做一件事：宿主新建了交接会话之后，把界面切过去。
 *   1. 轮询宿主自己的 /api/handoff/status（同源，带 cookie），读到新的 newSessionId；
 *   2. 等它在客户端会话表里可寻址，然后调用 sessions 上的切换方法；
 *   3. 每个会话只切一次（localStorage 去重）；失败不清标记，下次再来。
 *
 * 为什么这么多防御：这个 harness 版本的「切会话」方法名没有公开文档，
 * 而同类插件的写法（WeiYe6 的 sessions.open / conversationEvents）在当前版本里
 * 有的存在、有的不存在。所以这里按可能性依次探测，并把**实际命中的方法名和
 * sessions 的 API 清单**回报给宿主（/api/handoff/client → 宿主写成文件），
 * 让下一次改动有据可依，而不是靠猜。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-handoff',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const POLL_MS = 2000
    const OPENED_PREFIX = 'dsh-session-handoff.opened.v1'
    const OPEN_METHODS = ['open', 'openSession', 'activate', 'select', 'show', 'focus']
    const WAIT_ATTEMPTS = 12
    const WAIT_STEP_MS = 500

    /** sessions 上第一个可用的「切过去」方法名；没有就返回空串。 */
    function openMethod(sessions) {
      if (sessions === null || typeof sessions !== 'object') return ''
      for (const name of OPEN_METHODS) {
        if (typeof sessions[name] === 'function') return name
      }
      return ''
    }

    /** sessions 上所有能看到的成员名（自有 + 原型），用来回报真实 API 面。 */
    function apiSurface(sessions) {
      const names = new Set()
      if (sessions === null || typeof sessions !== 'object') return []
      for (const key of Object.keys(sessions)) names.add(key)
      let proto = Object.getPrototypeOf(sessions)
      while (proto !== null && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) names.add(key)
        proto = Object.getPrototypeOf(proto)
      }
      names.delete('constructor')
      return Array.from(names).sort()
    }

    function report(payload) {
      try {
        fetch('/api/handoff/client', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch {}
    }

    function markOpened(key) {
      try { window.localStorage.setItem(key, '1') } catch {}
    }

    function wasOpened(key) {
      try { return window.localStorage.getItem(key) !== null } catch { return false }
    }

    function clearMark(key) {
      try { window.localStorage.removeItem(key) } catch {}
    }

    function sleep(ms) {
      return new Promise((resolve) => { window.setTimeout(resolve, ms) })
    }

    async function switchTo(sessions, method, sessionId) {
      const key = OPENED_PREFIX + ':' + sessionId
      try { window.localStorage.setItem(key, 'opening') } catch {}
      // 新会话可能还没进客户端的会话表，直接切会失败 —— 等它可寻址。
      if (typeof sessions.binding === 'function') {
        for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
          let binding
          try { binding = sessions.binding(sessionId) } catch { break }
          if (binding !== undefined && binding !== null) break
          await sleep(WAIT_STEP_MS)
        }
      }
      try {
        sessions[method](sessionId)
        markOpened(key)
        console.info('[dsh-session-handoff] switched to ' + sessionId + ' via sessions.' + method)
        report({ event: 'opened', sessionId, method, api: apiSurface(sessions) })
      } catch (error) {
        clearMark(key)
        console.warn('[dsh-session-handoff] switch failed: ' + String(error))
        report({ event: 'failed', sessionId, method, error: String(error), api: apiSurface(sessions) })
      }
    }

    function apply(ctx) {
      const sessions = ctx && ctx.sessions ? ctx.sessions : null
      const method = openMethod(sessions)
      const api = apiSurface(sessions)
      console.info('[dsh-session-handoff] client loaded; open method: ' + (method || '(none found)') + '; sessions api: ' + api.join(','))
      report({ event: 'client-loaded', method, api })

      // 侦察：这个 harness 版本的「切会话」没有公开文档，服务清单只能现场问。
      // 把注入到本模块的服务、以及像「切视图」的方法名报回去，下一次改动就有据可依。
      try {
        const keys = ctx && typeof ctx === 'object' ? Object.keys(ctx) : []
        const hints = /open|activate|select|show|focus|goto|navigate|enter|switch/i
        const services = []
        for (const key of keys) {
          let value = null
          try { value = ctx[key] } catch { continue }
          if (value === null || typeof value !== 'object') continue
          services.push(key + ': ' + (apiSurface(value).filter((name) => hints.test(name)).join(' ') || '-'))
        }
        report({
          event: 'client-probe',
          method,
          detail: {
            url: window.location ? String(window.location.href) : '',
            ctx: keys,
            services,
            manager: apiSurface(sessions && sessions.manager ? sessions.manager : null),
            sessions: api,
          },
        })
      } catch (error) {
        report({ event: 'client-probe-failed', error: String(error) })
      }

      let lastHandled = ''
      let running = true
      let statusFailed = ''

      const tick = async () => {
        if (!running) return
        try {
          const response = await fetch('/api/handoff/status', { headers: { accept: 'application/json' } })
          if (!response.ok) {
            // 宿主插件没加载时这里是 404 —— 报一次，别让它静默。
            if (statusFailed !== String(response.status)) {
              statusFailed = String(response.status)
              report({ event: 'status-failed', method, error: 'HTTP ' + statusFailed, api })
            }
            return
          }
          statusFailed = ''
          const snapshot = await response.json()
          const result = snapshot ? snapshot.lastResult : null
          if (!result || result.ok !== true || result.dryRun === true) return
          const sessionId = typeof result.newSessionId === 'string' ? result.newSessionId : ''
          if (sessionId === '' || sessionId === lastHandled) return
          if (wasOpened(OPENED_PREFIX + ':' + sessionId)) return
          lastHandled = sessionId
          if (method === '') {
            report({ event: 'no-open-api', sessionId, api })
            return
          }
          await switchTo(sessions, method, sessionId)
        } catch {}
      }

      const timer = window.setInterval(tick, POLL_MS)
      const stop = () => { running = false; window.clearInterval(timer) }
      if (ctx && typeof ctx.effect === 'function') ctx.effect(() => stop, 'dsh-session-handoff: status poll')
      tick()
    }

    exports.apply = apply
    exports.inject = ['sessions']
    exports.name = 'dsh-session-handoff-client'
    return module.exports
  },
})
