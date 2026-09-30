// ============================================================================
// dsh-notify —— DSH 通知插件（服务端半部）
//
// 职责：
//   1. 提供 /dsh-notify/audio.wav  —— 应用内通知提示音（随包自带）
//   2. 提供 /dsh-notify/events      —— SSE 下行：服务端检测到的事件推给网页
//   3. 提供 POST /dsh-notify/native —— 客户端失焦时调用，触发系统原生通知：
//        * Windows 10+  → scripts/dsh-toast.ps1（内置 WinRT Toast API）
//        * macOS         → osascript「display notification」（系统原生通知中心）
//   4. 监听 session/event：turn/end（任务完成/中断/失败）
//
// 待审批 / 待回答 / 计划审阅不走这里：客户端本地就有权威事实源
// （ctx.uiSession.sessionStatus），服务端再广播一份只会造成重复通知。
//
// 原生通知只做「通知」，不再做点击回调 / 一键审批 / 带回前台：
// 已移除 wscript.exe + dsh-activate.vbs + dsh-notify:// 自定义协议激活链路，
// 避免被 360 等安全软件误报为木马。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOAST_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'dsh-toast.ps1')
const AUDIO_FILE = path.join(PACKAGE_ROOT, 'assets', 'notify.wav')

const name = 'dsh-notify'
const inject = ['webServer', 'settings']

// DSH 0.1.7 起，插件的设置不再用 ctx.settings.register(ns, schema) 单独注册命名空间，
// 而是以模块导出的 Config schema 声明，并成为 Loader 里本插件条目的配置。
// 客户端通过 ctx.configForms.get('dsh-notify') 读写它——那个 id 由
// cordis.patch.yml 的 `id:` 决定，必须与客户端里的 NOTIFY_ENTRY_ID 保持一致。
const Config = z.object({
  enabled: z.boolean().default(true),
  inApp: z.boolean().default(true),
  sound: z.boolean().default(true),
  native: z.boolean().default(true),
  newSession: z.boolean().default(true),
  approval: z.boolean().default(true),
  question: z.boolean().default(true),
  taskComplete: z.boolean().default(true),
  taskInterrupted: z.boolean().default(true),
  jobs: z.boolean().default(true),
})

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

function projectName(session) {
  try {
    const cwd = session && session.header && session.header.cwd
    if (!cwd || typeof cwd !== 'string') return 'DeepSeek Harness'
    const base = cwd.split(/[\\/]/).filter(Boolean).pop()
    return base || 'DeepSeek Harness'
  } catch (err) {
    return 'DeepSeek Harness'
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// macOS AppleScript 字符串转义：转义反斜杠与双引号，折叠换行/制表符，剔除其他控制字符
function appleEscape(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
}

function apply(ctx, config) {
  // 本插件在 Web UI 里有自己的设置页，关掉 DSH 的自动生成页，避免出现两个「通知」页。
  try {
    ctx.settings.configure({ auto: false })
  } catch (err) { /* 设置服务不可用或该 API 不存在时忽略 */ }

  // 解析后的配置（0.1.7 由 Loader 按 Config schema 校验后传入）。Config schema 里
  // 每个字段都有 default，所以 config 正常总是对象；仍做兜底以防手写 profile 配置残缺。
  const settings = config && typeof config === 'object' ? config : {}
  const settingsGet = (field, fallback) =>
    settings[field] !== undefined ? settings[field] : fallback

  const sseClients = new Set()
  const recentNative = new Map() // tag -> timestamp（防多标签页/高频重复）
  const disposers = []

  function broadcast(msg) {
    const data = 'data: ' + JSON.stringify(msg) + '\n\n'
    for (const res of sseClients) {
      try { res.write(data) } catch (err) { /* ignore */ }
    }
  }

  // ---- 音频 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/audio.wav',
    handler: (req, res) => {
      try {
        const bytes = fs.readFileSync(AUDIO_FILE)
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('audio unavailable: ' + String((err && err.message) || err))
      }
    },
  }))

  // ---- SSE 下行 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/events',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      sseClients.add(res)
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n') } catch (err) { /* closed */ }
      }, 25000)
      const onClose = () => {
        clearInterval(heartbeat)
        sseClients.delete(res)
      }
      req.on('close', onClose)
      res.on('error', onClose)
    },
  }))

  // ---- Windows 原生 Toast（纯通知，无按钮/无激活） ----
  function showWindowsToast(title, text, tag) {
    const tmpFile = path.join(os.tmpdir(), 'dsh-notify-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
    const cleanup = () => { try { fs.unlinkSync(tmpFile) } catch (err) { /* ignore */ } }
    try {
      fs.writeFileSync(tmpFile, JSON.stringify({ title, body: text, tag }), 'utf8')
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', TOAST_SCRIPT,
        '-Show', tmpFile,
      ], { windowsHide: true, stdio: 'ignore' })
      ps.on('error', cleanup)
      ps.on('exit', cleanup)
    } catch (err) {
      cleanup()
    }
  }

  // ---- macOS 原生通知（osascript，零第三方依赖） ----
  function showMacToast(title, text) {
    const script = 'display notification "' + appleEscape(text) + '" with title "' + appleEscape(title) + '"'
    const ps = spawn('osascript', ['-e', script], { stdio: 'ignore' })
    ps.on('error', () => { /* osascript 不可用（如非 macOS） */ })
  }

  // ---- 客户端请求系统原生通知 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/native',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const payload = JSON.parse(body || '{}')
        const title = String(payload.title || 'DSH-DeepSeek Harness').slice(0, 64)
        const text = String(payload.body || '').slice(0, 200)
        const tag = String(payload.tag || 'dsh-notify').slice(0, 64)

        // 设置开关：总开关或系统通知被关闭时不再弹原生通知
        if (settingsGet('enabled', true) === false || settingsGet('native', true) === false) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, disabled: true }))
          return
        }

        // 简单去重：同一 tag 短时间内只弹一次
        const now = Date.now()
        const last = recentNative.get(tag)
        if (last && now - last < 800) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, deduped: true }))
          return
        }
        recentNative.set(tag, now)
        if (recentNative.size > 256) {
          const oldest = [...recentNative.entries()].sort((a, b) => a[1] - b[1])[0]
          if (oldest) recentNative.delete(oldest[0])
        }

        const platform = process.platform
        if (platform === 'win32') {
          showWindowsToast(title, text, tag)
        } else if (platform === 'darwin') {
          showMacToast(title, text)
        }

        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, platform }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  // ---- 会话事件检测：任务完成/中断/失败 ----
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (settingsGet('enabled', true) === false) return
      const type = event && event.type
      if (type === 'turn/end') {
        // 子代理各自拥有独立会话（header.origin === 'subagent'）。它们的每一轮都会
        // turn/end，一次 fan-out 工作流能刷出几十条通知，直接在这里拦掉。
        if (session && session.header && session.header.origin === 'subagent') return
        const reason = event.data && event.data.reason
        const kind = reason && reason.kind ? reason.kind : 'completed'
        broadcast({
          kind: 'turn-end',
          sessionId: session && session.id,
          title: projectName(session),
          reason: kind,
        })
      }
    } catch (err) { /* 通知失败不影响主流程 */ }
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) { /* ignore */ }
    }
    for (const res of sseClients) {
      try { res.end() } catch (err) { /* ignore */ }
    }
  }, 'dsh-notify: server')
}

export { apply, Config, inject, name }
