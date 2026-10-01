/**
 * dsh-session-handoff — web client（手写模块，无构建步骤）。
 *
 * 只做一件事：宿主新建了交接会话之后，把界面切过去。
 *   1. 轮询宿主自己的 /api/handoff/status（同源，带 cookie），读到新的 newSessionId；
 *   2. 等它出现在客户端的会话目录里（sessions.list）；
 *   3. 调 ctx.uiWorkspace.openSession(id) 切过去；
 *   4. 每个会话只切一次（localStorage 去重）；失败不清标记，下次再来。
 *
 * 为什么是 uiWorkspace.openSession：
 *   - ctx.sessions 是数据/注册表服务，它自己的接口文档写着 "navigation belongs to view owners"，
 *     没有任何切视图的方法（实测枚举过 41 个成员）；
 *   - 视图所有者是 dsh-client-ui-workspace 客户端插件，它对外暴露 UiWorkspace 服务，
 *     其 replaceMain() 内部就是 sessions.retain(id, {source:'mainView'}) + 换选中 + 释放旧的；
 *   - 公开的 UiWorkspace.openSession(target) 的文档原话："Select a Session and show its
 *     Conversation as one UI navigation action."
 * 老版本（WeiYe6 针对的 0.1.1-rc.2）用的是 ctx.sessions.open，那个在当前版本已经不存在。
 *
 * 找不到接口时不轮询、不做无用功，只把服务清单一并回报给宿主（/api/handoff/client → 落盘），
 * 免得下次还得靠猜。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-handoff',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const POLL_MS = 2000
    const OPENED_PREFIX = 'dsh-session-handoff.opened.v1'
    const WAIT_ATTEMPTS = 12
    const WAIT_STEP_MS = 500
    // 每次回报都带上它 —— 界面里跑的到底是哪一版，一眼可见（脚本被缓存过时全靠它）。
    const CLIENT_BUILD = 'client-2026-10-02d'

    // 首选：视图所有者的公开导航接口（文档见 dsh-client-ui-workspace 的 navigation.d.ts）。
    const PREFERRED = [
      ['uiWorkspace', 'openSession'],
      ['uiWorkspace', 'startSession'],
    ]
    // 退回：在候选服务里找这些名字（老版本叫 sessions.open）。
    const OPEN_METHODS = ['openSession', 'open', 'activate', 'select', 'show', 'focus', 'goto', 'navigate']
    const CANDIDATE_SERVICES = [
      'uiWorkspace', 'uiSession', 'uiConversation', 'uiLayout', 'uiChat', 'uiCommands', 'uiSidebar',
      'uiTool', 'uiSettings', 'uiSlots', 'sessions', 'slots', 'remote', 'connection', 'locale',
      'workspace', 'workspaces', 'tabs', 'rooms', 'shell', 'navigation', 'app', 'view', 'screen',
      'panel', 'agents', 'projects', 'theme', 'ui', 'window',
    ]
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

    /** 每次用的时候现问一次 —— 服务可能比本模块晚注册。 */
    function findSwitch(ctx) {
      for (const pair of PREFERRED) {
        const service = resolveService(ctx, pair[0])
        if (service !== null && typeof service.value[pair[1]] === 'function') {
          return { service: pair[0], method: pair[1], value: service.value }
        }
      }
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

    /** 新会话得先出现在客户端目录里，否则 openSession 拿不到它。 */
    async function waitCatalogued(ctx, sessionId) {
      const sessions = resolveService(ctx, 'sessions')
      if (sessions === null || !sessions.value.list || typeof sessions.value.list.getSnapshot !== 'function') return
      for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
        try {
          const snapshot = sessions.value.list.getSnapshot()
          if (snapshot && snapshot.byId && snapshot.byId[sessionId]) return
        } catch { return }
        await sleep(WAIT_STEP_MS)
      }
    }

    async function switchTo(ctx, target, sessionId) {
      const key = OPENED_PREFIX + ':' + sessionId
      try { window.localStorage.setItem(key, 'opening') } catch {}
      await waitCatalogued(ctx, sessionId)
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

      // 侦察：把点名问到的服务的方法面报回去（有界）。找不到切视图接口时这条最关键。
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
            services,
            full,
          },
        })
      } catch (error) {
        report({ event: 'client-probe-failed', error: String(error) })
      }

      if (target === null) {
        // 这一版 harness 没有公开的切视图接口 —— 不轮询，不做无用功。
        report({ event: 'no-open-api', method: '' })
        return
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
