// ============================================================================
// dsh-notify —— DSH 通知插件（服务端半部）
//
// 职责：
//   1. 提供 /dsh-notify/audio.wav           —— 应用内通知提示音（随包自带）
//   2. 提供 /dsh-notify/events              —— SSE 下行：服务端检测到的事件推给网页
//   3. 提供 POST /dsh-notify/native         —— 客户端在失焦时调用，触发 Windows 原生 Toast
//   4. 提供 POST /dsh-notify/activate       —— 原生 Toast 被点击后的激活回调（带一次性 nonce）
//   5. 监听 session/event：turn/end（任务完成/中断/失败）与 approval/asked（待审批）
//
// 原生 Toast 由 scripts/dsh-toast.ps1 实现：纯 Windows PowerShell 5.1 + 内置 WinRT
// Toast API。只写 HKCU 注册表（AppUserModelId + dsh-notify:// 自定义协议），
// 不创建 .lnk 快捷方式，Windows 10+ 通用，兼容火绒等安全软件，
// 不依赖 Windows App SDK / .NET 运行时 / 任何第三方模块。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOAST_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'dsh-toast.ps1')
const AUDIO_FILE = path.join(PACKAGE_ROOT, 'assets', 'notify.wav')

const name = 'dsh-notify'
const inject = ['webServer', 'settings']

// ---- 设置命名空间（DSH Web UI 设置 → 通知） ----
const NOTIFY_NAMESPACE = 'dsh-notify'
const NotifySettingsSchema = z.object({
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

const TOKEN_TTL_MS = 10 * 60 * 1000 // 激活 nonce 有效期

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

function encodeToken(nonce, origin) {
  return Buffer.from(JSON.stringify({ n: nonce, u: origin }), 'utf8').toString('base64url')
}

function decodeToken(token) {
  try {
    const parsed = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'))
    if (typeof parsed.n === 'string' && typeof parsed.u === 'string') return parsed
  } catch (err) { /* fallthrough */ }
  return null
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

function apply(ctx) {
  let settingsScope = null
  try {
    settingsScope = ctx.settings.register(NOTIFY_NAMESPACE, NotifySettingsSchema, { applies: 'live' })
  } catch (err) { /* 命名空间已注册或设置服务不可用时继续 */ }
  const settingsGet = (field, fallback) => {
    try {
      if (!settingsScope) return fallback
      const value = settingsScope.get()
      return value && typeof value === 'object' && value[field] !== undefined ? value[field] : fallback
    } catch (err) { return fallback }
  }
  const sseClients = new Set()
  const pendingActivations = new Map() // nonce -> { action, expiresAt, origin }
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

  // ---- 客户端请求原生 Toast ----
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
        const kind = String(payload.kind || 'info')
        const origin = String(payload.origin || '').slice(0, 240)
        const sessionId = payload.sessionId ? String(payload.sessionId).slice(0, 120) : null

        // 设置开关：总开关或系统通知被关闭时不再弹原生 Toast
        if (settingsGet('enabled', true) === false || settingsGet('native', true) === false) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, disabled: true }))
          return
        }

        // 按钮列表：每个按钮一个独立 nonce，点击时服务端才能区分“批准/拒绝/查看”
        const requested = Array.isArray(payload.actions) ? payload.actions.slice(0, 3) : []
        const buttons = requested.map((a) => {
          const label = String((a && a.label) || '查看').slice(0, 12)
          const action = a && a.action && typeof a.action === 'object'
            ? a.action
            : { type: 'open', sessionId }
          const nonce = randomBytes(16).toString('hex')
          pendingActivations.set(nonce, { action, expiresAt: Date.now() + TOKEN_TTL_MS, origin })
          return { label, token: 'D' + encodeToken(nonce, origin) }
        })
        if (buttons.length === 0) {
          const nonce = randomBytes(16).toString('hex')
          pendingActivations.set(nonce, { action: { type: 'open', sessionId }, expiresAt: Date.now() + TOKEN_TTL_MS, origin })
          buttons.push({ label: '查看', token: 'D' + encodeToken(nonce, origin) })
        }
        // toast 本体点击 = 打开该会话（或第一个按钮的动作）
        const launchAction = sessionId ? { type: 'open', sessionId } : buttons[0].action
        const launchNonce = randomBytes(16).toString('hex')
        pendingActivations.set(launchNonce, { action: launchAction, expiresAt: Date.now() + TOKEN_TTL_MS, origin })

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

        const tmpFile = path.join(os.tmpdir(), 'dsh-notify-' + launchNonce + '.json')
        fs.writeFileSync(tmpFile, JSON.stringify({
          title,
          body: text,
          tag,
          kind,
          buttons,
          launch: 'D' + encodeToken(launchNonce, origin),
        }), 'utf8')

        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden',
          '-File', TOAST_SCRIPT,
          '-Show', tmpFile,
        ], { windowsHide: true, stdio: 'ignore' })
        ps.on('error', () => { try { fs.unlinkSync(tmpFile) } catch (err) {} })
        ps.on('exit', () => { try { fs.unlinkSync(tmpFile) } catch (err) {} })

        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  // ---- 原生 Toast 激活回调（PowerShell 激活实例 POST 过来） ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/activate',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}')
        const token = String(parsed.token || '')
        if (!token) throw new Error('missing token')
        const decoded = decodeToken(token)
        if (!decoded) throw new Error('bad token')
        const entry = pendingActivations.get(decoded.n)
        if (!entry || entry.expiresAt < Date.now()) {
          pendingActivations.delete(decoded.n)
          throw new Error('token expired')
        }
        pendingActivations.delete(decoded.n)
        broadcast({ kind: 'activate', action: entry.action || null })
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  // ---- 清理过期 nonce ----
  const ttlTimer = setInterval(() => {
    const now = Date.now()
    for (const [nonce, entry] of pendingActivations) {
      if (entry.expiresAt < now) pendingActivations.delete(nonce)
    }
  }, 60 * 1000)

  // ---- 会话事件检测：任务完成/中断/失败 + 待审批 ----
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (settingsGet('enabled', true) === false) return
      const type = event && event.type
      if (type === 'turn/end') {
        const reason = event.data && event.data.reason
        const kind = reason && reason.kind ? reason.kind : 'completed'
        broadcast({
          kind: 'turn-end',
          sessionId: session && session.id,
          title: projectName(session),
          reason: kind,
        })
      } else if (type === 'approval/asked') {
        broadcast({
          kind: 'approval',
          sessionId: session && session.id,
          approvalId: event.data && event.data.id,
          toolName: event.data && event.data.toolName,
          reason: event.data && event.data.reason,
          title: projectName(session),
        })
      }
    } catch (err) { /* 通知失败不影响主流程 */ }
  }))

  ctx.effect(() => () => {
    clearInterval(ttlTimer)
    for (const d of disposers) {
      try { d() } catch (err) { /* ignore */ }
    }
    for (const res of sseClients) {
      try { res.end() } catch (err) { /* ignore */ }
    }
  }, 'dsh-notify: server')
}

export { apply, inject, name }
