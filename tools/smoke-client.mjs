// 临时冒烟测试：在无浏览器环境下打桩，验证 dsh-notify 客户端的接线
// （sessionStatus / jobs 订阅 / configForms / 子代理过滤 / 优雅降级）。
// 运行：node tools/smoke-client.mjs
// 用途：DSH 大版本升级后（客户端服务改名/移除）快速回归，防止插件静默停在 pending。
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

// ---------- React / ReactDOM 桩 ----------
const captured = { store: null, factory: null, sectionOpts: null, sectionComp: null }
const React = {
  createElement(type, props) { return { type, props: props || {} } },
  useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
}
const ReactDOM = {
  createRoot() {
    return {
      render(el) { if (el && el.props && el.props.store) captured.store = el.props.store },
      unmount() {},
    }
  },
  render(el) { if (el && el.props && el.props.store) captured.store = el.props.store },
  unmountComponentAtNode() {},
}

// ---------- 浏览器桩 ----------
const ls = new Map()
const documentStub = {
  hasFocus: () => true,
  visibilityState: 'visible',
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
}
const windowStub = {
  __ModuleLoader__: { load(spec) { captured.factory = spec.factory } },
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener() {}, removeEventListener() {},
}
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
}
globalThis.Audio = class { play() { return Promise.resolve() } }
const eventSources = []
globalThis.EventSource = class {
  constructor(url) { this.url = url; eventSources.push(this) }
  close() {}
}
globalThis.fetch = () => Promise.resolve({ ok: true })

new Function('window', 'document', 'localStorage', 'Audio', 'EventSource', 'fetch', source)(
  windowStub, documentStub, globalThis.localStorage, globalThis.Audio, globalThis.EventSource, globalThis.fetch)

const mod = captured.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error('unexpected require: ' + name)
})

// ---------- DSH 0.1.7 服务桩 ----------
assert.deepEqual(mod.inject, ['sessions', 'slots'], 'inject 只应保留核心服务')

const SETTINGS = {
  enabled: true, inApp: true, sound: true, native: true, newSession: true,
  approval: true, question: true, taskComplete: true, taskInterrupted: true, jobs: true,
}
const NOW = Date.now()
const HOUR = 3600 * 1000
let listState = {
  phase: 'ready',
  ids: ['s1', 's2'],
  byId: {
    s1: { id: 's1', displayTitle: 'proj', blank: false, running: true, updatedAt: NOW },
    s2: { id: 's2', displayTitle: 'proj', blank: false, running: false, updatedAt: NOW },
  },
}
const listSubs = new Set()
const sessions = {
  list: {
    getSnapshot: () => listState,
    subscribe: (fn) => { listSubs.add(fn); return () => listSubs.delete(fn) },
  },
  open() {},
}
const emitList = () => listSubs.forEach((fn) => fn())

// uiSession：0.1.7 的 sessionStatus + adapter.current
let statusMap = new Map()
const statusSubs = new Set()
const currentSubs = new Set()
const current = { value: undefined }
const uiSession = {
  sessionStatus: {
    getSnapshot: () => statusMap,
    subscribe: (fn) => { statusSubs.add(fn); return () => statusSubs.delete(fn) },
  },
  adapter: {
    current: {
      getSnapshot: () => (current.value ? { key: current.value } : undefined),
      subscribe: (fn) => { currentSubs.add(fn); return () => currentSubs.delete(fn) },
    },
  },
}
const emitStatus = () => statusSubs.forEach((fn) => fn())
const setCurrent = (id) => { current.value = id; currentSubs.forEach((fn) => fn()) }

// jobs：0.1.7 的 ctx.jobs（名册按会话订阅）
let jobsRows = {}
const jobsSubs = new Set()
const watched = new Map()
const jobs = {
  state: {
    getSnapshot: () => ({ rows: jobsRows, observed: {} }),
    subscribe: (fn) => { jobsSubs.add(fn); return () => jobsSubs.delete(fn) },
  },
  watchRows(sessionId) {
    watched.set(sessionId, (watched.get(sessionId) || 0) + 1)
    return () => { watched.set(sessionId, watched.get(sessionId) - 1) }
  },
}
const emitJobs = () => jobsSubs.forEach((fn) => fn())

// configForms：0.1.7 的设置读写面
const configForm = {
  getSnapshot: () => ({ status: 'ready', value: SETTINGS, revision: 1, writable: true, mode: 'host' }),
  subscribe: () => () => {},
  set: async () => true,
}
const requestedEntries = []
const configForms = { get: (entryId) => { requestedEntries.push(entryId); return configForm } }

const scope = { getSnapshot: () => ({ status: 'ready', value: SETTINGS }), subscribe: () => () => {}, set: async () => {} }
function slotsStub() {
  return {
    inject(_n, cb) { cb() },
    register(opts, comp) { captured.sectionOpts = opts; captured.sectionComp = comp; return () => {} },
  }
}
function makeCtx(extra = {}) {
  return Object.assign({
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    // 插件直接以属性访问 ctx.slots / ctx.locale（cordis 注入后的形态）
    slots: slotsStub(),
    locale: { register() {}, bind: () => (k) => k },
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'slots') return slotsStub()
      if (name === 'uiSession') return uiSession
      if (name === 'jobs') return jobs
      if (name === 'configForms') return configForms
      if (name === 'locale') return { register() {}, bind: () => (k) => k }
      return undefined
    },
  }, extra)
}

// ---------- 加载 ----------
mod.apply(makeCtx())
const toastStore = captured.store
assert(toastStore, 'toast host mounted')
const snapshot = () => toastStore.getSnapshot()
const bodyOf = (t) => t.body

// 1) 基线：apply 时列表里的会话不该补通知
assert.equal(snapshot().length, 0, '基线不补通知（全新会话）')

// 2) 新会话 → 通知
listState = Object.assign({}, listState, {
  ids: ['s1', 's2', 's3'],
  byId: Object.assign({}, listState.byId, { s3: { id: 's3', displayTitle: 'proj', blank: false, running: true, updatedAt: NOW } }),
})
emitList()
assert.equal(snapshot().length, 1, '新会话应通知')
assert.match(bodyOf(snapshot()[0]), /新会话已创建/)
toastStore.remove(snapshot()[0].id)

// 2b) 子代理会话 → 不通知（且不订阅它的任务名册）
listState = Object.assign({}, listState, {
  ids: ['s1', 's2', 's3', 'sub1'],
  byId: Object.assign({}, listState.byId, {
    sub1: { id: 'sub1', displayTitle: 'sub', blank: false, origin: 'subagent', running: true, updatedAt: NOW },
  }),
})
emitList()
assert.equal(snapshot().length, 0, '子代理会话不应产生「新会话」通知')

// 2c) 陈旧会话 → 不订阅任务名册（控制订阅数量）
listState = Object.assign({}, listState, {
  ids: ['s1', 's2', 's3', 'sub1', 'old1'],
  byId: Object.assign({}, listState.byId, {
    old1: { id: 'old1', displayTitle: 'old', blank: false, running: false, updatedAt: NOW - 48 * HOUR },
  }),
})
emitList()
assert.equal(watched.get('old1'), undefined, '48h 未活动的会话不应被 watchRows')
assert.equal(watched.get('s1'), 1, '运行中的会话应被 watchRows')
assert.equal(watched.get('s2'), 1, '近期活跃的会话应被 watchRows')

// 2d) 切换当前会话 → 立即补上它的订阅
setCurrent('old1')
assert.equal(watched.get('old1'), 1, '当前会话应被 watchRows（即使已陈旧）')
setCurrent(undefined)
snapshot().slice().forEach((t) => toastStore.remove(t.id)) // old1 作为新会话本就该通知，先清干净

// 4) 后台任务结束 → 通知
jobsRows = { s1: [{ id: 'job-1', label: 'build', status: 'running' }] }
emitJobs() // 先记录为 running
jobsRows = { s1: [{ id: 'job-1', label: 'build', status: 'completed' }] }
emitJobs()
const jobToast = snapshot().find((t) => /后台任务完成/.test(bodyOf(t)))
assert(jobToast, '后台任务完成应通知')
assert.match(bodyOf(jobToast), /build/)
toastStore.remove(jobToast.id)

// 4b) SSE turn/end：普通会话通知，子代理不通知
const es = eventSources[0]
assert(es, '应已建立 SSE 连接')
es.onmessage({ data: JSON.stringify({ kind: 'turn-end', sessionId: 'sub1', title: 'proj', reason: 'completed' }) })
assert.equal(snapshot().length, 0, '子代理的 turn/end 不应通知')
es.onmessage({ data: JSON.stringify({ kind: 'turn-end', sessionId: 's1', title: 'proj', reason: 'completed' }) })
assert(snapshot().some((t) => /任务完成/.test(bodyOf(t))), '普通会话的 turn/end 应通知')
snapshot().slice().forEach((t) => toastStore.remove(t.id))

// 5) 待审批（sessionStatus）→ 通知带 批准/拒绝
const approval = {
  sessionId: 's2', key: 'approval:1', kind: 'approval', toolName: 'pwsh',
  reason: '工具 pwsh 请求授权执行', answers: [],
  answer(outcome) { this.answers.push(outcome); return Promise.resolve() },
}
statusMap = new Map([['s2', { running: true, pendingInteraction: approval, completionUnread: false }]])
emitStatus()
const apprToast = snapshot().find((t) => t.kind === 'approval')
assert(apprToast, '待审批应通知')
assert.deepEqual(apprToast.actions.map((a) => a.label), ['批准', '拒绝'])

// 6) 批准 → answer('allowed-once') + 回执
apprToast.actions[0].onClick()
await new Promise((r) => setImmediate(r))
assert.deepEqual(approval.answers, ['allowed-once'], '应以 allowed-once 应答')
assert(snapshot().some((t) => /已批准执行/.test(bodyOf(t))), '应显示批准回执')

// 7) 待办在别处解决 → Toast 撤下
const q = { sessionId: 's2', key: 'question:1', kind: 'question', questions: [{ id: 'q', question: '选哪个？' }], answer: () => Promise.resolve() }
statusMap = new Map([['s2', { running: true, pendingInteraction: q, completionUnread: false }]])
emitStatus()
assert(snapshot().some((t) => t.toastKey === 'pending:question:1'), '待回答应通知')
statusMap = new Map()
emitStatus()
assert(!snapshot().some((t) => t.toastKey === 'pending:question:1'), '解决后应撤下 Toast')

// 8) 设置：应通过 configForms 取 'dsh-notify' 条目
const face = captured.sectionOpts.inject()
assert.equal(face.scope, configForm, '设置面板应绑定 configForms 的表单')
assert(requestedEntries.includes('dsh-notify'), "configForms.get('dsh-notify') 应被调用")

// 9) 优雅降级：uiSession / jobs / configForms 全缺席也要能加载
captured.store = null
mod.apply(makeCtx({
  get(name) {
    if (name === 'sessions') return sessions
    return undefined
  },
}))
assert(captured.store, '缺少可选服务时插件仍应加载')
assert(captured.sectionOpts, '设置分区仍应注册')

console.log('OK: 客户端接线全部通过（sessionStatus / jobs 订阅有界 / configForms / 子代理过滤 / 优雅降级）')
