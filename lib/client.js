// ============================================================================
// dsh-notify —— DSH 通知插件（浏览器/客户端半部）
//
// 职责：
//   1. 在 DSH Web GUI 内渲染 Telegram 风格的应用内 Toast（右上角堆叠）
//   2. 焦点在应用内时播放提示音 + 显示应用内通知
//   3. 焦点在应用外时请求服务端弹 Windows 原生 Toast
//   4. 原生 Toast 的“批准/拒绝”按钮点击后，通过服务端 SSE 回到这里，
//      用 PendingWait.respond() 真正应答审批并打开对应会话
//   5. 事件来源：
//        - SSE（服务端）：turn/end（任务完成/中断/失败）、approval/asked（待审批）
//        - ctx.sessions.list：新会话、question/plan-review 待回答、后台任务（jobs）完成/中断
//
// 以预打包 bundle 形式随插件安装，格式与官方 client 插件一致（__ModuleLoader__）。
// ============================================================================
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var ReactDOM = require('react-dom')

    // ------------------------------------------------------------------
    // 样式（使用 DSH 语义化 CSS 变量，自动适配明暗主题）
    // ------------------------------------------------------------------
    var CSS = [
      '.dshn-root{position:fixed;top:16px;right:16px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;width:min(372px,calc(100vw - 32px));pointer-events:none;font-family:var(--dsw-font-family,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);box-sizing:border-box}',
      '.dshn-root *{box-sizing:border-box}',
      '.dshn-toast{pointer-events:auto;background:var(--dsw-alias-bg-layer-2,#ffffff);color:var(--dsw-alias-label-primary,#1c1c1e);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:14px;box-shadow:var(--dsw-shadow-lv3,0 10px 28px rgba(0,0,0,.18));padding:12px 14px;display:flex;flex-direction:column;gap:7px;animation:dshn-in .18s ease;overflow:hidden;border-left:3px solid var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshn-toast.dshn-success{border-left-color:var(--dsw-alias-state-success-primary,#2fa95e)}',
      '.dshn-toast.dshn-approval,.dshn-toast.dshn-warn{border-left-color:var(--dsw-alias-state-warn-primary,#d9822b)}',
      '.dshn-toast.dshn-error{border-left-color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.dshn-toast.dshn-info{border-left-color:var(--dsw-alias-state-business-primary,#4c7ef3)}',
      '@keyframes dshn-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
      '.dshn-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dshn-icon{flex:none;width:18px;height:18px;color:var(--dsw-alias-label-secondary,#5b616b)}',
      '.dshn-toast.dshn-success .dshn-icon{color:var(--dsw-alias-state-success-primary,#2fa95e)}',
      '.dshn-toast.dshn-approval .dshn-icon,.dshn-toast.dshn-warn .dshn-icon{color:var(--dsw-alias-state-warn-primary,#d9822b)}',
      '.dshn-toast.dshn-error .dshn-icon{color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.dshn-toast.dshn-info .dshn-icon{color:var(--dsw-alias-state-business-primary,#4c7ef3)}',
      '.dshn-title{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshn-close{flex:none;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);border-radius:6px;cursor:pointer;font-size:15px;line-height:1;padding:0}',
      '.dshn-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1c1c1e)}',
      '.dshn-body{font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary,#3c4043);word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:default}',
      '.dshn-body.dshn-clickable{cursor:pointer}',
      '.dshn-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}',
      '.dshn-btn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1c1c1e);border-radius:8px;padding:4px 12px;font-size:12px;line-height:18px;cursor:pointer}',
      '.dshn-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.1))}',
      '.dshn-btn.dshn-btn-primary{background:var(--dsw-alias-state-business-primary,#4c7ef3);border-color:transparent;color:#fff}',
      '.dshn-btn.dshn-btn-primary:hover{background:var(--dsw-alias-state-business-primary-hover,#3d6ce0)}',
      '.dshn-btn.dshn-btn-danger{background:var(--dsw-alias-state-error-primary,#d64545);border-color:transparent;color:#fff}',
      '.dshn-btn.dshn-btn-danger:hover{background:#c13c3c}',
      '.dshn-settings{display:flex;flex-direction:column;gap:14px;max-width:560px;font-family:var(--dsw-font-family,ui-sans-serif,system-ui,"Segoe UI",sans-serif)}',
      '.dshn-settings-title{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary,#1c1c1e)}',
      '.dshn-settings-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b616b)}',
      '.dshn-settings-sub{margin:14px 0 4px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#1c1c1e)}',
      '.dshn-settings-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));cursor:pointer}',
      '.dshn-settings-check{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary,#4c7ef3);width:16px;height:16px;flex:none;cursor:pointer}',
      '.dshn-settings-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dshn-settings-rowTitle{font-size:13px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary,#1c1c1e)}',
      '.dshn-settings-rowDesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshn-settings-actions{display:flex;flex-wrap:wrap;gap:8px}',
      '.dshn-settings-btn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1c1c1e);border-radius:8px;padding:6px 14px;font-size:13px;line-height:18px;cursor:pointer}',
      '.dshn-settings-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.1))}',
      '.dshn-settings-warn{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#d9822b)}',
      '.dshn-settings-logHead{display:flex;align-items:center;gap:12px;justify-content:space-between}',
      '.dshn-settings-btn-small{padding:2px 10px;font-size:12px}',
      '.dshn-settings-log{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto}',
      '.dshn-log-empty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshn-log-row{display:flex;gap:8px;align-items:baseline;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));font-size:12px;line-height:17px}',
      '.dshn-log-time{flex:none;font-family:var(--dsw-font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap}',
      '.dshn-log-title{flex:none;max-width:170px;font-weight:500;color:var(--dsw-alias-label-primary,#1c1c1e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshn-log-body{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#5b616b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshn-log-channel{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap}'
    ].join('\n')
    ;(function () {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-notify-css]')) return
      var tag = document.createElement('style')
      tag.setAttribute('data-dsh-notify-css', '1')
      tag.textContent = CSS
      document.head.appendChild(tag)
    })()

    // ------------------------------------------------------------------
    // 通知 store（外部数据源，供 useSyncExternalStore 消费）
    // ------------------------------------------------------------------
    function createToastStore() {
      var toasts = []
      var listeners = new Set()
      var seq = 0
      function emit() {
        listeners.forEach(function (fn) {
          try { fn() } catch (e) { /* ignore */ }
        })
      }
      function removeById(id) {
        var next = toasts.filter(function (t) { return t.id !== id })
        if (next.length !== toasts.length) {
          toasts = next
          emit()
        }
      }
      return {
        getSnapshot: function () { return toasts },
        subscribe: function (fn) {
          listeners.add(fn)
          return function () { listeners.delete(fn) }
        },
        push: function (t) {
          var item = Object.assign({}, t, { id: 'dshn-' + (++seq), createdAt: Date.now() })
          toasts = toasts.concat(item).slice(-4)
          emit()
          if (item.autoDismiss !== false) {
            window.setTimeout(function () { removeById(item.id) }, item.duration || 7000)
          }
          return item
        },
        remove: function (id) { removeById(id) }
      }
    }

    // ------------------------------------------------------------------
    // React 组件
    // ------------------------------------------------------------------
    function iconSvg(kind) {
      var cls = 'dshn-icon'
      if (kind === 'approval') {
        return React.createElement('svg', { className: cls, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('path', { d: 'M8 1.8 13 4v4.2c0 2.6-2 5-5 6-3-1-5-3.4-5-6V4l5-2.2Z' }),
          React.createElement('path', { d: 'M5.8 8.2 7.3 9.7l3-3.2' }))
      }
      if (kind === 'success') {
        return React.createElement('svg', { className: cls, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('circle', { cx: 8, cy: 8, r: 6.2 }),
          React.createElement('path', { d: 'M5.2 8.2 7.2 10.2 11 6.4' }))
      }
      if (kind === 'error') {
        return React.createElement('svg', { className: cls, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('circle', { cx: 8, cy: 8, r: 6.2 }),
          React.createElement('path', { d: 'M6 6l4 4M10 6l-4 4' }))
      }
      return React.createElement('svg', { className: cls, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M8 2.2c-2.4 0-4 1.6-4 3.6 0 2.4-.9 3.6-1.3 4.4-.3.6.1 1.2.8 1.2h9c.7 0 1.1-.6.8-1.2-.4-.8-1.3-2-1.3-4.4 0-2-1.6-3.6-4-3.6Z' }),
        React.createElement('path', { d: 'M6.4 12.6a1.7 1.7 0 0 0 3.2 0' }))
    }

    function ToastItem(props) {
      var toast = props.toast
      var onClose = props.onClose
      return React.createElement('div',
        { className: 'dshn-toast dshn-' + (toast.kind || 'info'), 'data-dsh-plugin': 'notify' },
        React.createElement('div', { className: 'dshn-head' },
          iconSvg(toast.kind || 'info'),
          React.createElement('span', { className: 'dshn-title', title: toast.title }, toast.title),
          React.createElement('button', { type: 'button', className: 'dshn-close', 'aria-label': '关闭', onClick: onClose }, '×')),
        React.createElement('div',
          { className: 'dshn-body' + (toast.onOpen ? ' dshn-clickable' : ''), onClick: toast.onOpen || undefined, title: toast.onOpen ? '点击打开会话' : undefined },
          toast.body),
        toast.actions && toast.actions.length
          ? React.createElement('div', { className: 'dshn-actions' },
              toast.actions.map(function (a, i) {
                return React.createElement('button', {
                  key: i,
                  type: 'button',
                  className: 'dshn-btn' + (a.primary ? ' dshn-btn-primary' : '') + (a.danger ? ' dshn-btn-danger' : ''),
                  onClick: a.onClick
                }, a.label)
              }))
          : null
      )
    }

    function ToastHost(props) {
      var store = props.store
      var toasts = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      return React.createElement('div', { className: 'dshn-root' },
        toasts.map(function (t) {
          return React.createElement(ToastItem, {
            key: t.id,
            toast: t,
            onClose: function () { store.remove(t.id) }
          })
        }))
    }

    // ------------------------------------------------------------------
    // 工具函数
    // ------------------------------------------------------------------
    function clip(text, max) {
      var s = String(text || '')
      if (s.length <= max) return s
      return s.slice(0, max - 1) + '…'
    }

    function titleOf(list, sessionId, fallback) {
      try {
        var row = list && list.byId && list.byId[sessionId]
        if (row && row.displayTitle) return 'DSH-' + row.displayTitle
      } catch (e) { /* ignore */ }
      return 'DSH-' + (fallback || 'DeepSeek Harness')
    }

    function playSound() {
      try {
        if (!window.__dshNotifyAudio) {
          var a = new Audio('/dsh-notify/audio.wav')
          a.preload = 'auto'
          a.volume = 0.5
          window.__dshNotifyAudio = a
        }
        var el = window.__dshNotifyAudio
        el.currentTime = 0
        var p = el.play()
        if (p && typeof p.catch === 'function') p.catch(function () { /* ignore */ })
      } catch (e) { /* ignore */ }
    }

    function sleep(ms) {
      return new Promise(function (resolve) { window.setTimeout(resolve, ms) })
    }

    // ------------------------------------------------------------------
    // 设置面板（DSH Web UI 设置里的「通知」页）
    // ------------------------------------------------------------------
    var NOTIFY_DEFAULTS = {
      enabled: true,
      inApp: true,
      sound: true,
      native: true,
      newSession: true,
      approval: true,
      question: true,
      taskComplete: true,
      taskInterrupted: true,
      jobs: true
    }

    var LOCALE_NS = 'dsh-notify'
    var LOCALE_ZH = {
      nav: '通知',
      desc: '管理 dsh-notify 通知行为：焦点在 DSH 内使用应用内通知，失焦时使用 Windows 原生通知；原生通知栏可直接点击「批准」完成审批。'
    }
    var LOCALE_EN = {
      nav: 'Notifications',
      desc: 'Manage dsh-notify notifications: in-app toasts while focused, native Windows toasts while unfocused; approvals can be granted directly from the toast.'
    }

    // ---- 通知日志（localStorage 持久化，上限 100 条） ----
    var LOG_KEY = 'dshn:log'
    var NOTIFIED_KEY = 'dshn:notified'
    var logListeners = new Set()
    var logSnapshot = []
    function loadLog() {
      try {
        var raw = localStorage.getItem(LOG_KEY)
        var arr = raw ? JSON.parse(raw) : []
        return Array.isArray(arr) ? arr : []
      } catch (e) { return [] }
    }
    function saveLog(arr) {
      try { localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-100))) } catch (e) { /* ignore */ }
    }
    function refreshLog() {
      logSnapshot = loadLog()
      logListeners.forEach(function (fn) { try { fn() } catch (e) { /* ignore */ } })
    }
    function pushLog(entry) {
      var arr = loadLog()
      arr.push(entry)
      saveLog(arr)
      refreshLog()
    }
    function clearLog() {
      try { localStorage.removeItem(LOG_KEY) } catch (e) { /* ignore */ }
      refreshLog()
    }
    var logStore = {
      getSnapshot: function () { return logSnapshot },
      subscribe: function (fn) {
        logListeners.add(fn)
        return function () { logListeners.delete(fn) }
      }
    }
    refreshLog()

    // ---- 已通知去重（重启后不再重复通知同一事件） ----
    function loadNotified() {
      try {
        var raw = localStorage.getItem(NOTIFIED_KEY)
        var o = raw ? JSON.parse(raw) : {}
        return o && typeof o === 'object' ? o : {}
      } catch (e) { return {} }
    }
    function wasNotified(key) {
      var o = loadNotified()
      return !!o[key]
    }
    function markNotified(key) {
      var o = loadNotified()
      o[key] = Date.now()
      var keys = Object.keys(o)
      if (keys.length > 600) {
        var cutoff = Date.now() - 7 * 864e5
        for (var i = 0; i < keys.length; i++) {
          if (o[keys[i]] < cutoff) delete o[keys[i]]
        }
      }
      try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(o)) } catch (e) { /* ignore */ }
    }

    // 时间格式：2026-08-23 22:45:01 GMT+8（按本地时区偏移推导）
    function formatNotifyTime(ts) {
      try {
        var d = new Date(ts)
        var pad = function (n) { return n < 10 ? '0' + n : String(n) }
        var off = -d.getTimezoneOffset()
        var sign = off >= 0 ? '+' : '-'
        var abs = Math.abs(off)
        var tz = 'GMT' + sign + (abs % 60 === 0 ? String(abs / 60) : (abs / 60).toFixed(1).replace(/\.0$/, ''))
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + tz
      } catch (e) { return String(ts) }
    }

    function NotifyToggle(field, label, desc, checked, onSet) {
      return React.createElement('label', { key: field, className: 'dshn-settings-row' },
        React.createElement('input', {
          type: 'checkbox',
          className: 'dshn-settings-check',
          checked: !!checked,
          onChange: function (e) { onSet(field, e.target.checked) }
        }),
        React.createElement('span', { className: 'dshn-settings-rowText' },
          React.createElement('span', { className: 'dshn-settings-rowTitle' }, label),
          desc ? React.createElement('span', { className: 'dshn-settings-rowDesc' }, desc) : null))
    }

    function NotifySettingsSection(props) {
      var scope = props.scope
      var test = props.test || {}
      var defaults = props.defaults || NOTIFY_DEFAULTS
      // 注意：scope.subscribe/getSnapshot 是类原型方法，必须绑定 this，
      // 直接传给 useSyncExternalStore 会因 this 丢失而崩溃（this.store undefined）。
      var snap = scope
        ? React.useSyncExternalStore(
            function (listener) { return scope.subscribe(listener) },
            function () { return scope.getSnapshot() })
        : { status: 'unavailable', value: undefined }
      var value = Object.assign({}, defaults, (snap && snap.value) || {})
      function set(field, checked) {
        if (!scope) return
        scope.set(field, !!checked).catch(function () { /* ignore */ })
      }
      var rows = [
        { key: 'enabled', label: '启用通知', desc: '总开关：关闭后不再发出任何通知' },
        { key: 'inApp', label: '应用内通知', desc: '在 DSH 界面右上角显示 Telegram 风格通知' },
        { key: 'sound', label: '提示音', desc: '焦点在应用内时播放提示音' },
        { key: 'native', label: '系统通知', desc: '焦点在应用外时弹出 Windows 原生通知' }
      ]
      var scenes = [
        { key: 'newSession', label: '新会话' },
        { key: 'approval', label: '待审批' },
        { key: 'question', label: '待回答 / 计划审阅' },
        { key: 'taskComplete', label: '任务完成' },
        { key: 'taskInterrupted', label: '任务中断 / 失败' },
        { key: 'jobs', label: '后台任务' }
      ]
      return React.createElement('section', { className: 'dshn-settings', 'aria-labelledby': 'dshn-settings-title' },
        React.createElement('h2', { id: 'dshn-settings-title', className: 'dshn-settings-title' }, '通知'),
        React.createElement('p', { className: 'dshn-settings-desc' }, '管理 dsh-notify 通知行为：焦点在 DSH 内使用应用内通知，失焦时使用 Windows 原生通知；原生通知栏可直接点击「批准」完成审批。'),
        rows.map(function (row) {
          return NotifyToggle(row.key, row.label, row.desc, value[row.key], set)
        }),
        React.createElement('h3', { className: 'dshn-settings-sub' }, '通知场景'),
        scenes.map(function (scene) {
          return NotifyToggle(scene.key, scene.label, null, value[scene.key], set)
        }),
        React.createElement('h3', { className: 'dshn-settings-sub' }, '测试'),
        React.createElement('div', { className: 'dshn-settings-actions' },
          React.createElement('button', { type: 'button', className: 'dshn-settings-btn', onClick: function () { if (test.testInApp) test.testInApp() } }, '测试应用内通知'),
          React.createElement('button', { type: 'button', className: 'dshn-settings-btn', onClick: function () { if (test.testNative) test.testNative() } }, '测试系统通知'),
          React.createElement('button', { type: 'button', className: 'dshn-settings-btn', onClick: function () { if (test.testApproval) test.testApproval() } }, '测试审批通知')),
        React.createElement('div', { className: 'dshn-settings-logHead' },
          React.createElement('h3', { className: 'dshn-settings-sub' }, '通知日志（已通知）'),
          React.createElement('button', { type: 'button', className: 'dshn-settings-btn dshn-settings-btn-small', onClick: function () { clearLog() } }, '清空日志')),
        React.createElement('div', { className: 'dshn-settings-log' },
          React.createElement(NotifyLog, null)),
        snap && snap.status === 'unavailable'
          ? React.createElement('p', { className: 'dshn-settings-warn' }, '当前环境无法持久化设置（非本机 DSH），本次修改仅当前页面生效。')
          : null)
    }

    function NotifyLog() {
      var logs = React.useSyncExternalStore(logStore.subscribe, logStore.getSnapshot)
      if (!logs || logs.length === 0) {
        return React.createElement('p', { className: 'dshn-log-empty' }, '暂无通知记录')
      }
      return React.createElement('div', { className: 'dshn-log-list' },
        logs.slice().reverse().map(function (entry, i) {
          return React.createElement('div', { key: String(entry.t) + '-' + i, className: 'dshn-log-row' },
            React.createElement('span', { className: 'dshn-log-time' }, formatNotifyTime(entry.t)),
            React.createElement('span', { className: 'dshn-log-title', title: entry.title }, entry.title),
            React.createElement('span', { className: 'dshn-log-body', title: entry.body }, entry.body || ''),
            React.createElement('span', { className: 'dshn-log-channel' }, entry.channel || ''))
        }))
    }

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------
    var inject = ['sessions', 'slots', 'settingsScope', 'locale']

    function apply(ctx) {
      // ---- 字典 ----
      var translate = null
      try {
        ctx.locale.register(LOCALE_NS, { zh: LOCALE_ZH, en: LOCALE_EN })
        translate = ctx.locale.bind(LOCALE_NS)
      } catch (e) { /* 字典注册失败不影响功能 */ }

      // ---- 设置：惰性绑定 dsh-notify 命名空间（服务端注册于 ctx.settings） ----
      var settingsScopeCached = null
      var testApi = {}
      function getSettingsScope() {
        if (settingsScopeCached) return settingsScopeCached
        try {
          var svc = ctx.get('settingsScope')
          if (svc) {
            settingsScopeCached = svc.bind({ namespace: 'dsh-notify', decode: function (v) { return v } })
          }
        } catch (e) { /* ignore */ }
        return settingsScopeCached
      }
      function readSettings() {
        var d = NOTIFY_DEFAULTS
        var scope = getSettingsScope()
        if (!scope) return d
        try {
          var snap = scope.getSnapshot()
          var v = snap && snap.value
          if (v && typeof v === 'object') return Object.assign({}, d, v)
        } catch (e) { /* ignore */ }
        return d
      }

      ctx.effect(function () {
        var sessions = ctx.get('sessions')
        var store = createToastStore()
        var focused = document.hasFocus()
        var mounted = false
        var rootEl = null
        var disposers = []

        // ---- 挂载 React 根 ----
        try {
          rootEl = document.createElement('div')
          rootEl.setAttribute('data-dsh-plugin', 'notify')
          document.body.appendChild(rootEl)
          if (ReactDOM.createRoot) {
            var root = ReactDOM.createRoot(rootEl)
            root.render(React.createElement(ToastHost, { store: store }))
            mounted = true
            disposers.push(function () {
              try { root.unmount() } catch (e) { /* ignore */ }
              if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl)
            })
          } else {
            ReactDOM.render(React.createElement(ToastHost, { store: store }), rootEl)
            mounted = true
            disposers.push(function () {
              try { ReactDOM.unmountComponentAtNode(rootEl) } catch (e) { /* ignore */ }
              if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl)
            })
          }
        } catch (e) { /* 渲染失败不影响通知主流程 */ }

        // ---- 焦点跟踪 ----
        function updateFocus() {
          focused = document.hasFocus() && document.visibilityState !== 'hidden'
        }
        window.addEventListener('focus', updateFocus)
        window.addEventListener('blur', updateFocus)
        document.addEventListener('visibilitychange', updateFocus)
        disposers.push(function () {
          window.removeEventListener('focus', updateFocus)
          window.removeEventListener('blur', updateFocus)
          document.removeEventListener('visibilitychange', updateFocus)
        })

        // ---- 通知入口 ----
        function notify(opts) {
          var s = readSettings()
          if (s.enabled === false) return
          if (opts.category && s[opts.category] === false) return
          if (opts.notifyKey && wasNotified(opts.notifyKey)) return
          var item = {
            title: opts.title,
            body: clip(opts.body || '', 160),
            kind: opts.kind || 'info',
            sessionId: opts.sessionId || null,
            actions: [],
            onOpen: opts.sessionId ? function () { try { sessions.open(opts.sessionId) } catch (e) { /* ignore */ } } : undefined
          }
          var nativeActions = []
          var hasActions = Array.isArray(opts.actions)
          if (hasActions) {
            opts.actions.forEach(function (a) {
              item.actions.push({
                label: a.label,
                primary: !!a.primary,
                danger: !!a.danger,
                onClick: a.onClick || (a.nativeAction ? function () { handleActivate(a.nativeAction) } : undefined)
              })
              if (a.nativeAction) nativeActions.push({ label: a.label, action: a.nativeAction })
            })
          } else if (opts.sessionId) {
            item.actions.push({
              label: '查看',
              primary: true,
              onClick: function () { try { sessions.open(opts.sessionId) } catch (e) { /* ignore */ } }
            })
            nativeActions.push({ label: '查看', action: { type: 'open', sessionId: opts.sessionId } })
          }
          var showInApp = mounted && s.inApp !== false
          var showNative = !focused && s.native !== false
          if (!showInApp && !showNative) return

          if (showInApp) store.push(item)
          if (focused) {
            if (showInApp && s.sound !== false) playSound()
          } else if (showNative) {
            requestNative({
              title: opts.title,
              body: clip(opts.body || '', 200),
              kind: opts.kind || 'info',
              tag: opts.tag || 'dsh-notify',
              sessionId: opts.sessionId || null,
              actions: nativeActions
            })
          }

          if (opts.notifyKey) markNotified(opts.notifyKey)
          pushLog({
            t: Date.now(),
            title: opts.title,
            body: clip(opts.body || '', 160),
            kind: opts.kind || 'info',
            channel: focused ? '应用内' : (showInApp ? '应用内+系统' : '系统')
          })
        }

        function requestNative(payload) {
          try {
            fetch('/dsh-notify/native', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(Object.assign({ origin: location.origin }, payload))
            }).catch(function () { /* ignore */ })
          } catch (e) { /* ignore */ }
        }

        // ---- 审批应答 ----
        function findPendingWait(sessionId, predicate) {
          try {
            var binding = sessions.binding(sessionId)
            if (!binding) return null
            var snap = binding.session.getSnapshot()
            var arr = (snap && snap.pending) || []
            for (var i = 0; i < arr.length; i++) {
              if (predicate(arr[i])) return arr[i]
            }
          } catch (e) { /* ignore */ }
          return null
        }

        function answerApproval(sessionId, approvalId, outcome) {
          return new Promise(function (resolve) {
            try { sessions.open(sessionId) } catch (e) { /* ignore */ }
            var started = Date.now()
            var timer = window.setInterval(function () {
              var wait = findPendingWait(sessionId, function (w) {
                return w && w.kind === 'approval' && w.payload && w.payload.approvalId === approvalId
              })
              if (wait) {
                window.clearInterval(timer)
                try {
                  wait.respond({ ok: true, value: { sessionId: sessionId, approvalId: approvalId, outcome: outcome } })
                    .then(function () { resolve(true) })
                    .catch(function () { resolve(false) })
                } catch (e) { resolve(false) }
                return
              }
              if (Date.now() - started > 6000) {
                window.clearInterval(timer)
                resolve(false)
              }
            }, 150)
          })
        }

        function handleActivate(action) {
          if (!action || typeof action !== 'object') return
          if (action.type === 'approve' && action.sessionId && action.approvalId) {
            answerApproval(action.sessionId, action.approvalId, 'allowed-once')
          } else if (action.type === 'reject' && action.sessionId && action.approvalId) {
            answerApproval(action.sessionId, action.approvalId, 'rejected')
          } else if (action.type === 'open' && action.sessionId) {
            try { sessions.open(action.sessionId) } catch (e) { /* ignore */ }
          }
          try { window.focus() } catch (e) { /* ignore */ }
        }

        // ---- 设置面板的测试按钮 ----
        testApi.testInApp = function () {
          if (!mounted) return
          store.push({
            title: 'DSH-通知测试',
            body: '这是一条应用内通知，提示音已播放 ✓',
            kind: 'info',
            actions: []
          })
          playSound()
          pushLog({ t: Date.now(), title: 'DSH-通知测试', body: '这是一条应用内通知，提示音已播放 ✓', kind: 'info', channel: '测试' })
        }
        testApi.testNative = function () {
          requestNative({
            title: 'DSH-通知测试',
            body: '这是一条 Windows 系统通知（来自 dsh-notify 测试）',
            kind: 'info',
            tag: 'dsh-notify-test-native-' + Date.now(),
            sessionId: null,
            actions: [{ label: '知道了', action: { type: 'open', sessionId: null } }]
          })
          pushLog({ t: Date.now(), title: 'DSH-通知测试', body: '这是一条 Windows 系统通知（来自 dsh-notify 测试）', kind: 'info', channel: '测试' })
        }
        testApi.testApproval = function () {
          if (!mounted) return
          store.push({
            title: 'DSH-通知测试',
            body: '这是一条审批风格通知（模拟工具请求授权）',
            kind: 'approval',
            actions: [
              { label: '批准(模拟)', primary: true, onClick: function () {
                  store.push({ title: 'DSH-通知测试', body: '已模拟批准 ✓', kind: 'success', actions: [] })
                } },
              { label: '拒绝(模拟)', danger: true, onClick: function () {
                  store.push({ title: 'DSH-通知测试', body: '已模拟拒绝', kind: 'info', actions: [] })
                } }
            ]
          })
          pushLog({ t: Date.now(), title: 'DSH-通知测试', body: '这是一条审批风格通知（模拟工具请求授权）', kind: 'approval', channel: '测试' })
        }

        // ---- 会话列表监听：新会话 / question / plan-review / jobs ----
        var seenSessions = new Set()
        var blankState = new Map()
        var pendingShown = new Map()
        var jobStatus = new Map()
        var notifiedApprovals = new Set()
        var lastListSnapshot = null
        var baselineSeeded = false

        function onList() {
          var list = sessions.list.getSnapshot()
          lastListSnapshot = list
          var byId = list.byId || {}

          // 首次就绪快照 = 基线：只“记住”现状，不通知（避免每次重启把历史会话/待办全部刷一遍）
          if (!baselineSeeded) {
            if (list.phase !== 'ready') return
            baselineSeeded = true
            Object.keys(byId).forEach(function (id) {
              seenSessions.add(id)
              blankState.set(id, !!byId[id].blank)
            })
            Object.keys(byId).forEach(function (id) {
              var pi = byId[id].pendingInteraction
              if (pi === 'approval' || pi === 'question' || pi === 'plan-review') {
                pendingShown.set(id, pi)
              }
            })
            var seedJobs = list.jobsBySession || {}
            Object.keys(seedJobs).forEach(function (sid) {
              ;(seedJobs[sid] || []).forEach(function (job) {
                jobStatus.set(sid + ':' + job.id, job.status)
              })
            })
          }

          Object.keys(byId).forEach(function (id) {
            var row = byId[id]
            if (!seenSessions.has(id)) {
              seenSessions.add(id)
              blankState.set(id, !!row.blank)
              if (!row.blank) notifyNewSession(row)
            } else {
              var wasBlank = blankState.get(id)
              if (wasBlank && !row.blank) {
                blankState.set(id, false)
                notifyNewSession(row)
              }
            }
          })

          Object.keys(byId).forEach(function (id) {
            var row = byId[id]
            var pi = row.pendingInteraction
            if (pi === 'approval' || pi === 'question' || pi === 'plan-review') {
              var shown = pendingShown.get(id)
              if (shown !== pi) {
                pendingShown.set(id, pi)
                handlePendingInteraction(row, pi)
              }
            } else if (pendingShown.has(id)) {
              pendingShown.delete(id)
            }
          })

          var jobs = list.jobsBySession || {}
          var liveJobKeys = new Set()
          Object.keys(jobs).forEach(function (sessionId) {
            ;(jobs[sessionId] || []).forEach(function (job) {
              var key = sessionId + ':' + job.id
              liveJobKeys.add(key)
              var prev = jobStatus.get(key)
              if (prev && (prev === 'running' || prev === 'stopping') && prev !== job.status &&
                  (job.status === 'completed' || job.status === 'killed' || job.status === 'failed')) {
                notifyJob(sessionId, job)
              }
              jobStatus.set(key, job.status)
            })
          })
          for (var key of jobStatus.keys()) {
            if (!liveJobKeys.has(key)) jobStatus.delete(key)
          }

          if (notifiedApprovals.size > 256) notifiedApprovals.clear()
        }

        function rowOf(sessionId) {
          try {
            return lastListSnapshot.byId[sessionId]
          } catch (e) { return null }
        }

        function notifyNewSession(row) {
          var title = 'DSH-' + (row.displayTitle || '新会话')
          notify({
            title: title,
            body: '新会话已创建：' + (row.displayTitle || row.cwd || row.id),
            kind: 'info',
            category: 'newSession',
            notifyKey: 'session:' + row.id,
            tag: 'session:' + row.id,
            sessionId: row.id,
            actions: [{ label: '查看', primary: true, nativeAction: { type: 'open', sessionId: row.id } }]
          })
        }

        function handlePendingInteraction(row, pi) {
          var sessionId = row.id
          var list = sessions.list.getSnapshot()
          if (focused && list.current === sessionId) return // 用户正在看这个会话，界面本身已提示
          if (pi === 'approval') {
            // 主路径是 SSE 的 approval 事件（带 approvalId）；这里是兜底
            var wait = findPendingWait(sessionId, function (w) { return w && w.kind === 'approval' })
            var approvalId = wait && wait.payload && wait.payload.approvalId ? wait.payload.approvalId : null
            var reason = wait && wait.payload && wait.payload.reason ? wait.payload.reason : null
            var tool = wait && wait.payload && wait.payload.toolName ? wait.payload.toolName : '工具'
            var actions = approvalId
              ? [
                  { label: '批准', primary: true, nativeAction: { type: 'approve', sessionId: sessionId, approvalId: approvalId }, onClick: function () { answerApproval(sessionId, approvalId, 'allowed-once') } },
                  { label: '拒绝', danger: true, nativeAction: { type: 'reject', sessionId: sessionId, approvalId: approvalId }, onClick: function () { answerApproval(sessionId, approvalId, 'rejected') } }
                ]
              : [{ label: '查看', primary: true, nativeAction: { type: 'open', sessionId: sessionId } }]
            notify({
              title: titleOf(list, sessionId, 'DeepSeek Harness'),
              body: reason || ('工具 ' + tool + ' 请求授权执行'),
              kind: 'approval',
              category: 'approval',
              tag: 'approval-fallback:' + sessionId,
              sessionId: sessionId,
              actions: actions
            })
            return
          }
          // question / plan-review
          var q = findPendingWait(sessionId, function (w) { return w && (w.kind === 'question') })
          var body = ''
          if (q && q.payload && q.payload.questions && q.payload.questions.length) {
            body = '有待回答：' + clip(q.payload.questions[0].question || '请回答问题', 120)
          } else {
            body = pi === 'plan-review' ? '有待你审阅的计划' : '有待回答的问题'
          }
          notify({
            title: titleOf(list, sessionId, 'DeepSeek Harness'),
            body: body,
            kind: pi === 'plan-review' ? 'warn' : 'info',
            category: 'question',
            tag: 'question:' + sessionId + ':' + pi,
            sessionId: sessionId,
            actions: [{ label: '查看', primary: true, nativeAction: { type: 'open', sessionId: sessionId } }]
          })
        }

        function notifyJob(sessionId, job) {
          var list = sessions.list.getSnapshot()
          var body = ''
          var kind = 'info'
          if (job.status === 'completed') { body = '后台任务完成：' + job.label; kind = 'success' }
          else if (job.status === 'killed') { body = '后台任务被中断：' + job.label; kind = 'error' }
          else if (job.status === 'failed') { body = '后台任务失败：' + job.label + (job.detail ? '（' + job.detail + '）' : ''); kind = 'error' }
          else return
          notify({
            title: titleOf(list, sessionId, 'DeepSeek Harness'),
            body: clip(body, 200),
            kind: kind,
            category: 'jobs',
            tag: 'job:' + job.id,
            sessionId: sessionId,
            actions: [{ label: '查看', primary: true, nativeAction: { type: 'open', sessionId: sessionId } }]
          })
        }

        // ---- SSE：服务端事件 ----
        function handleServerMessage(msg) {
          if (!msg || typeof msg.kind !== 'string') return
          if (msg.kind === 'turn-end') handleTurnEnd(msg)
          else if (msg.kind === 'approval') handleApproval(msg)
          else if (msg.kind === 'activate') handleActivate(msg.action)
        }

        function handleTurnEnd(msg) {
          var sessionId = msg.sessionId
          if (!sessionId) return
          var list = sessions.list.getSnapshot()
          if (focused && list.current === sessionId) return // 正在看这个会话，不打扰
          var reason = msg.reason || 'completed'
          var labels = {
            completed: '任务完成',
            aborted: '任务被中断',
            error: '任务失败',
            blocked: '任务受阻',
            interrupted: '任务被中断',
            'max-tokens': '回答达到输出上限'
          }
          var body = labels[reason] || '任务结束'
          var kind = reason === 'completed' ? 'success' : (reason === 'error' || reason === 'aborted' || reason === 'interrupted' ? 'error' : 'warn')
          notify({
            title: 'DSH-' + (msg.title || 'DeepSeek Harness'),
            body: body,
            kind: kind,
            category: reason === 'completed' ? 'taskComplete' : 'taskInterrupted',
            tag: 'turn:' + sessionId + ':' + reason,
            sessionId: sessionId,
            actions: [{ label: '查看', primary: true, nativeAction: { type: 'open', sessionId: sessionId } }]
          })
        }

        function handleApproval(msg) {
          var sessionId = msg.sessionId
          var approvalId = msg.approvalId
          if (!sessionId || !approvalId) return
          if (notifiedApprovals.has(approvalId)) return
          notifiedApprovals.add(approvalId)
          var list = sessions.list.getSnapshot()
          if (focused && list.current === sessionId) return // 界面上已经有审批面板
          var body = msg.reason || ('工具 ' + (msg.toolName || '') + ' 请求授权执行')
          notify({
            title: 'DSH-' + (msg.title || 'DeepSeek Harness'),
            body: clip(body, 200),
            kind: 'approval',
            category: 'approval',
            notifyKey: 'approval:' + approvalId,
            tag: 'approval:' + approvalId,
            sessionId: sessionId,
            actions: [
              { label: '批准', primary: true, nativeAction: { type: 'approve', sessionId: sessionId, approvalId: approvalId }, onClick: function () { answerApproval(sessionId, approvalId, 'allowed-once') } },
              { label: '拒绝', danger: true, nativeAction: { type: 'reject', sessionId: sessionId, approvalId: approvalId }, onClick: function () { answerApproval(sessionId, approvalId, 'rejected') } }
            ]
          })
        }

        // ---- 订阅 ----
        disposers.push(sessions.list.subscribe(onList))
        var es = null
        try {
          es = new EventSource('/dsh-notify/events')
          es.onmessage = function (ev) {
            try { handleServerMessage(JSON.parse(ev.data)) } catch (e) { /* ignore */ }
          }
          disposers.push(function () { es.close() })
        } catch (e) { /* ignore */ }

        // ---- 清理 ----
        return function () {
          for (var i = disposers.length - 1; i >= 0; i--) {
            try { disposers[i]() } catch (e) { /* ignore */ }
          }
        }
      }, 'dsh-notify: notifications')

      // ---- 设置面板：DSH Web UI 设置 → 通知 ----
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-notify',
            order: 90,
            label: function () { return translate ? translate('nav') : '通知' },
            locale: LOCALE_NS,
            inject: function () {
              return { scope: getSettingsScope(), test: testApi, defaults: NOTIFY_DEFAULTS }
            }
          }, NotifySettingsSection)
        })
        if (typeof console !== 'undefined' && console.info) {
          console.info('[dsh-notify] settings.section registered')
        }
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-notify] settings.section registration failed:', e)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
