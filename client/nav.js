/**
 * dsh-session-handoff — web client（手写模块，无构建步骤）。
 *
 * 只做一件事：宿主新建了交接会话之后，把界面切过去。
 *   1. 轮询宿主自己的 /api/handoff/status（同源，带 cookie），读到新的 newSessionId；
 *   2. 等它在客户端会话表里可寻址，然后调用「切视图」的方法；
 *   3. 每个会话只切一次（localStorage 去重）；失败不清标记，下次再来。
 *
 * 为什么这么绕：这个 harness 版本的「切会话」接口没有公开文档，而同类插件的写法
 * （WeiYe6 的 sessions.open / conversationEvents）在当前版本里都不存在 —— sessions
 * 只是个数据/注册表服务。所以这里按官方文档出现过的服务名逐个点名问（ctx.get），
 * 把每个服务的真实方法面回报给宿主（/api/handoff/client → 落盘），并在候选里自动找
 * 切视图的方法。名字一旦问到，这里不用改代码就能用；问不到也有据可查。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-handoff',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const POLL_MS = 2000
    const OPENED_PREFIX = 'dsh-session-handoff.opened.v1'
    const OPEN_METHODS = ['open', 'openSession', 'activate', 'activateSession', 'select', 'selectSession', 'show', 'showSession', 'focus', 'goto', 'navigate']
    const WAIT_ATTEMPTS = 12
    const WAIT_STEP_MS = 500
    // 每次回报都带上它 —— 界面里跑的到底是哪一版，一眼可见（浏览器缓存过旧 bundle 时全靠它）。
    const CLIENT_BUILD = 'client-2026-10-02c'

    // 官方文档里出现过的客户端服务名 + 与视图/会话相关的常见名。点名问，不猜结构。
    const CANDIDATE_SERVICES = [
      'sessions', 'slots', 'locale', 'uiConversation', 'conversation', 'remote', 'connection',
      'commands', 'workspace', 'workspaces', 'tabs', 'rooms', 'shell', 'navigation', 'router',
      'app', 'view', 'views', 'screen', 'layout', 'panel', 'agents', 'agent', 'projects',
      'notifications', 'theme', 'ui', 'sidebar', 'window',
    ]
    // 能在这些服务上找「切视图」方法；别的服务即使有 open() 也不碰。
    const SWITCH_HINT = /ui|view|nav|shell|app|layout|tab|room|window|session|screen|panel|conversation/i

    function apiSurface(value) {
      const names = new Set()
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return []
      for (const key of Object.keys(value)) names.add(key)
      let proto = Object.getPrototypeOf(value)
      while (proto !== null && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) names.add(key)
        proto = Object.getPrototypeOf(proto)
      }
      names.delete('constructor')
      return Array.from(names).sort()
    }

    /** 按名字问服务：先 ctx.get(name)（cordis 正规途径），再退回 ctx[name]。 */
    function resolveService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const value = ctx.get(name)
          if (value !== null && value !== undefined) return { name, value, via: 'get' }
        }
      } catch {}
      try {
        const value = ctx ? ctx[name] : null
        if (value !== null && value !== undefined && (typeof value === 'object' || typeof value === 'function')) {
          return { name, value, via: 'prop' }
        }
      } catch {}
      return null
    }

    function allServices(ctx) {
      const out = []
      for (const name of CANDIDATE_SERVICES) {
        const found = resolveService(ctx, name)
        if (found !== null) out.push(found)
      }
      return out
    }

    function ownKeys(ctx) {
      const names = new Set()
      try { for (const key of Reflect.ownKeys(ctx)) names.add(String(key)) } catch {}
      let proto = ctx ? Object.getPrototypeOf(ctx) : null
      let depth = 0
      while (proto !== null && proto !== Object.prototype && depth < 6) {
        try { for (const key of Object.getOwnPropertyNames(proto)) names.add(key) } catch {}
        proto = Object.getPrototypeOf(proto)
        depth += 1
      }
      return Array.from(names).filter((name) => name !== 'constructor').sort()
    }

    /** 在候选服务里找「切视图」的方法。 */
    function findSwitch(ctx) {
      for (const service of allServices(ctx)) {
        if (!SWITCH_HINT.test(service.name)) continue
        for (const method of OPEN_METHODS) {
          if (typeof service.value[method] === 'function') {
            return { service: service.name, method, value: service.value }
          }
        }
      }
      return null
    }

    function report(payload) {
      try {
        fetch('/api/handoff/client', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ build: CLIENT_BUILD }, payload)),
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

    async function switchTo(ctx, target, sessionId) {
      const key = OPENED_PREFIX + ':' + sessionId
      try { window.localStorage.setItem(key, 'opening') } catch {}
      // 新会话可能还没进客户端的会话表，直接切会失败 —— 等它可寻址。
      const sessions = (() => { try { return ctx.get ? ctx.get('sessions') : ctx.sessions } catch { return null } })()
      if (sessions && typeof sessions.binding === 'function') {
        for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
          let binding
          try { binding = sessions.binding(sessionId) } catch { break }
          if (binding !== undefined && binding !== null) break
          await sleep(WAIT_STEP_MS)
        }
      }
      try {
        target.value[target.method](sessionId)
        markOpened(key)
        console.info('[dsh-session-handoff] switched to ' + sessionId + ' via ' + target.service + '.' + target.method)
        report({ event: 'opened', sessionId, method: target.service + '.' + target.method })
      } catch (error) {
        clearMark(key)
        console.warn('[dsh-session-handoff] switch failed: ' + String(error))
        report({ event: 'failed', sessionId, method: target.service + '.' + target.method, error: String(error) })
      }
    }

    function apply(ctx) {
      const target = findSwitch(ctx)
      report({ event: 'client-loaded', method: target ? target.service + '.' + target.method : '' })

      // 侦察：点名问每个候选服务，把方法面报回去（有界，别把请求撑爆）。
      try {
        const services = []
        const full = []
        for (const service of allServices(ctx)) {
          const names = apiSurface(service.value)
          const matched = names.filter((name) => /open|activate|select|show|focus|goto|navigate|enter|switch|current|active/i.test(name))
          services.push(service.name + '(' + service.via + '): ' + (matched.slice(0, 30).join(' ') || '-'))
          full.push(service.name + ' => ' + names.slice(0, 70).join(','))
        }
        report({
          event: 'client-probe',
          method: target ? target.service + '.' + target.method : '',
          detail: {
            url: window.location ? String(window.location.href) : '',
            ownKeys: ownKeys(ctx),
            services,
            full,
          },
        })
      } catch (error) {
        report({ event: 'client-probe-failed', error: String(error) })
      }

      let lastHandled = ''
      let running = true
      let statusFailed = ''
      let noApiReported = ''

      const tick = async () => {
        if (!running) return
        try {
          const response = await fetch('/api/handoff/status', { headers: { accept: 'application/json' } })
          if (!response.ok) {
            // 宿主插件没加载时这里是 404 —— 报一次，别让它静默。
            if (statusFailed !== String(response.status)) {
              statusFailed = String(response.status)
              report({ event: 'status-failed', error: 'HTTP ' + statusFailed })
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
          if (target === null || target === undefined) {
            if (noApiReported !== sessionId) {
              noApiReported = sessionId
              report({ event: 'no-open-api', sessionId })
            }
            return
          }
          await switchTo(ctx, target, sessionId)
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
