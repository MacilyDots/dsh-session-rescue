// 整合包集成测试：五项验收断言 + fetch 层级 + client 能力边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'rescue-integration-'))
process.env.DSH_HOME = HOME

const { apply, Config } = await import('../index.js')
const guardIndex = await import('../lib/degen-guard/index.js')

// ── mock ctx ───────────────────────────────────────────────────────────
function makeCtx(opts = {}) {
  const listeners = new Map()
  const routes = new Map()
  const commands = new Map()
  const provided = new Map()
  const effects = []
  const services = {
    agents: opts.agents ?? { async create() { throw new Error('no create in mock') } },
    sessionQuery: opts.sessionQuery,
    sessionController: opts.sessionController,
    agentPresets: opts.agentPresets,
    configEditor: opts.configEditor,
    webServer: {
      register(r) { routes.set(r.path, r.handler); return () => { routes.delete(r.path) } },
    },
    commands: { register(c) { commands.set(c.name, c) } },
    ...opts.services,
  }
  const ctx = {
    fiber: { entry: { id: 'session-rescue' } },
    commands: services.commands,
    webServer: services.webServer,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on(name, fn) { listeners.set(name, fn); return () => {} },
    effect(fn, label) { const d = fn(); effects.push({ label, dispose: d }); return d },
    inject(names, fn) {
      const host = new Proxy(ctx, {
        get(target, key) {
          if (key in services) return services[key]
          return Reflect.get(target, key)
        },
      })
      fn(host)
    },
    get(name) { return services[name] },
    provide(name, value) { provided.set(name, value); services[name] = value; return () => { provided.delete(name) } },
    fire(name, payload) { listeners.get(name)?.(payload) },
  }
  return { ctx, listeners, routes, commands, provided, effects, services, fire: ctx.fire }
}

// ── 断言 1：draft 也登记链深度 ─────────────────────────────────────────
test('draft 恢复也登记 child 深度（避免链式深度归零）', async () => {
  const registrations = []
  const service = {
    depthOf: async (id) => id === 'root' ? null : { depth: 2, parentSessionId: 'root', childSessionId: id, at: 1 },
    registerChildDepth: async (parent, child, depth) => {
      registrations.push({ parent, child, depth })
      return { registered: true, parentSessionId: parent, childSessionId: child, depth, at: 1 }
    },
    handoff: async (input) => {
      // 模拟服务在 prompt 前回调 onChildCreated。
      await input.onChildCreated?.({ childId: 'child-x', sourceId: input.sourceId, parentSessionId: input.parentSessionId, depth: input.depth, mode: input.mode })
      return { ok: true, state: 'draft', childId: 'child-x' }
    },
  }
  const m = makeCtx({ services: { sessionInherit: service } })
  apply(m.ctx, { guardEnabled: true, retryEnabled: false, inheritEnabled: false, onFused: { get: () => 'draft' }, maxTripsPerSession: 1, handoff: false })
  const agent = { id: 'root', whenIdle: async () => {}, cancel() {} }
  m.fire('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a' } })
  m.fire('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a', chunk: { type: 'reasoning-delta', text: '好。\n'.repeat(400) } } })
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.equal(registrations.length, 1, 'draft 模式未登记深度')
  assert.deepEqual(registrations[0], { parent: 'root', child: 'child-x', depth: 1 })
})

// ── 断言 2：configEditor YAML 热更新优先 ────────────────────────────────
test('/degen-mode 持久化成功后 YAML 后续改动立即生效', async () => {
  let ref = 'hint'
  let saved
  const m = makeCtx({ configEditor: { async edit(_entry, change) { saved = change({ mode: 'stop' }); ref = saved.onFused } } })
  apply(m.ctx, { guardEnabled: true, retryEnabled: false, inheritEnabled: false, onFused: { get: () => ref }, maxAutoChain: { get: () => 1 } })
  const cmd = m.commands.get('degen-mode')
  assert.ok(cmd)
  const r = await cmd.handler({ rawInput: 'auto' })
  assert.match(r.text, /持久保存/)
  const stats = m.routes.get('/dsh-degen-guard/stats')
  let body
  stats({ method: 'GET' }, { writeHead() {}, end(b) { body = JSON.parse(b) } })
  assert.equal(body.effectiveOnFused, 'auto')
  // 外部把 YAML（volatile ref）改回 hint —— 命令的旧 override 不得盖住它。
  ref = 'hint'
  stats({ method: 'GET' }, { writeHead() {}, end(b) { body = JSON.parse(b) } })
  assert.equal(body.effectiveOnFused, 'hint')
})

function sampleEvents() {
  return [
    { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1_700_000_001_000, data: { content: [{ type: 'text', text: '把 demo 的武器贴图修一下' }], source: { kind: 'user' } } },
    { type: 'request/header', seq: 3, time: 1_700_000_002_000, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }, reason: 'initial' } },
  ]
}

// ── 断言 3：auto 核验工作区 / 预设；登记失败改草稿且 child 不重建 ────────
test('auto 登记失败降级为草稿且只创建一个 child', async () => {
  const { createInheritService, clearDepthLedger } = await import('../lib/inherit/inherit-service.mjs')
  clearDepthLedger()
  const calls = { created: [], prompted: [], appended: [] }
  const sourceId = 'session-11111111-2222-3333-4444-555555555555'
  const childId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const header = { id: sourceId, cwd: process.cwd(), agentPreset: 'standard' }
  const services = {
    sessionQuery: { async readSession() { return { session: header, inheritedEventCount: 0, events: sampleEvents() } } },
    agents: { async create() { calls.created.push(1); return { agent: { session: { id: childId, append(t, d) { calls.appended.push(t) } } } } } },
    sessionController: { async prompt() { calls.prompted.push(1) } },
    agentPresets: { async resolve() { return {} }, async mount() {} },
  }
  const ctx = {
    agents: services.agents,
    get(n) { return services[n] }, effect(f) { return f() }, logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  const { resolveConfig } = await import('../lib/inherit/config.mjs')
  const service = createInheritService(ctx, resolveConfig({ presetAdapter: 'none', cacheTtlMs: 0 }))
  const result = await service.handoff({
    sourceId, mode: 'auto', depth: 0,
    onChildCreated: async () => { throw new Error('registration failed') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'draft-fallback', '登记失败应改草稿')
  assert.equal(calls.created.length, 1, 'child 被重建')
  assert.equal(calls.prompted.length, 0, '登记失败却启动了该 child')
  assert.ok(calls.appended.length > 0, '未以草稿写入同一 child')
})

// 工作区 / 预设核验：cwd 不存在时 auto 不启动。
test('auto 在工作区不存在时降级为草稿，不 prompt', async () => {
  const { createInheritService, clearDepthLedger } = await import('../lib/inherit/inherit-service.mjs')
  clearDepthLedger()
  const calls = { created: [], prompted: [], appended: [] }
  const sourceId = 'session-22222222-2222-3333-4444-555555555555'
  const childId = 'session-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
  const header = { id: sourceId, cwd: join(HOME, 'no-such-dir'), agentPreset: 'standard' }
  const services = {
    sessionQuery: { async readSession() { return { session: header, inheritedEventCount: 0, events: sampleEvents() } } },
    agents: { async create() { calls.created.push(1); return { agent: { session: { id: childId, append(t) { calls.appended.push(t) } } } } } },
    sessionController: { async prompt() { calls.prompted.push(1) } },
  }
  const ctx = { agents: services.agents, get(n) { return services[n] }, effect(f) { return f() }, logger: () => ({ info() {}, warn() {}, error() {} }) }
  const { resolveConfig } = await import('../lib/inherit/config.mjs')
  const service = createInheritService(ctx, resolveConfig({ presetAdapter: 'none', cacheTtlMs: 0 }))
  const result = await service.handoff({ sourceId, mode: 'auto', depth: 0 })
  assert.equal(result.state, 'draft-fallback')
  assert.equal(result.preflight.ok, false)
  assert.equal(calls.prompted.length, 0)
  assert.equal(calls.created.length, 1)
})

// ── 断言 4：服务单一注册 ────────────────────────────────────────────────
test('单入口只 provide 一次 sessionInherit 服务', () => {
  const m = makeCtx()
  apply(m.ctx, { guardEnabled: true, retryEnabled: false, inheritEnabled: true })
  assert.equal(m.provided.size, 1)
  assert.ok(m.provided.has('sessionInherit'))
})

// ── 断言 5：metadata 与 client 能力边界 ─────────────────────────────────
test('README 已存在；client 只注册快捷键，无扫描/自愈/上报端点', () => {
  const root = join(HOME, '..', '..') // 不用；直接读包内文件
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('README.md'))
  assert.ok(pkg.files.includes('README.zh-CN.md'))
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /Ctrl\+Shift\+R|renderer refresh shortcut/)
  assert.match(client, /keydown/)
  assert.match(client, /location\.reload/)
  for (const forbidden of ['setInterval', 'dsh-render-probe/report', 'css-injected', 'elementFromPoint', 'window-error', 'fetch(']) {
    assert.equal(client.includes(forbidden), false, `client.js 不应包含 ${forbidden}`)
  }
})

test('Config schema 保留旧字段 + volatile 新字段', () => {
  const parsed = Config({ mode: 'log', maxLineRepeat: 'legacy', unknownField: 42 })
  assert.equal(parsed.mode, 'log')
  assert.equal(parsed.maxLineRepeat, 'legacy')
  assert.equal(parsed.unknownField, 42)
  assert.equal(parsed.onFused.get(), 'hint')
  assert.equal(parsed.maxAutoChain.get(), 1)
})

// ── 断言 6：fetch 层级——wiretap 在 retry 外层 ────────────────────────────
test('wiretap 默认不装配；开启时位于 retry 外层，retry 可重发请求', async () => {
  const THINKING_ONLY = [
    { type: 'message_start', message: { id: 'm1', model: 'd', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const WITH_TEXT = [
    { type: 'message_start', message: { id: 'm2', model: 'd', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '好。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '正文。' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const sse = (events) => new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

  const baseFetch = (() => {
    let calls = 0
    const impl = async () => { calls += 1; return sse(calls === 1 ? THINKING_ONLY : WITH_TEXT) }
    impl.callCount = () => calls
    impl.reset = () => { calls = 0 }
    return impl
  })()
  const savedFetch = globalThis.fetch
  globalThis.fetch = baseFetch
  try {
    // 默认关闭：只装 retry。
    let m = makeCtx()
    apply(m.ctx, { guardEnabled: false, retryEnabled: true, inheritEnabled: false })
    assert.notEqual(globalThis.fetch, baseFetch)
    const afterRetryOnly = globalThis.fetch
    assert.equal(afterRetryOnly.name, 'reasoningRetryFetch')
    let response = await globalThis.fetch(new Request('https://api.example.com/v1/messages', {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'd', messages: [] }),
    }))
    await response.text()
    assert.equal(baseFetch.callCount(), 2, 'retry 应重发一次')

    // 重新干净安装：两个都开。wiretap 后 apply → 位于 retry 外层。
    globalThis.fetch = baseFetch
    baseFetch.reset()
    m = makeCtx()
    apply(m.ctx, { guardEnabled: false, retryEnabled: true, wiretapEnabled: true, inheritEnabled: false })
    assert.equal(globalThis.fetch.name, 'wiretapFetch', 'wiretap 必须是外层包装')
    response = await globalThis.fetch(new Request('https://api.example.com/v1/messages', {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'd', messages: [] }),
    }))
    const text = await response.text()
    assert.ok(text.includes('正文。'))
    // retry 内部绕过外层 wiretap 发起重试；底层 fetch 应被调两次。
    let waited = 0
    while (baseFetch.callCount() < 2 && waited < 100) {
      await new Promise(r => setTimeout(r, 10))
      waited += 1
    }
    assert.equal(baseFetch.callCount(), 2, 'retry 应让基线 fetch 被调两次')

    // 卸载（effect 逆序）：wiretap 先卸，retry 后卸，最终恢复基线。
    for (const e of [...m.effects].reverse()) { try { e.dispose?.() } catch { /* ignore */ } }
    assert.equal(globalThis.fetch, baseFetch, '全部卸载后应恢复基线 fetch')
  } finally {
    globalThis.fetch = savedFetch
  }
})

test.after(() => rmSync(HOME, { recursive: true, force: true }))
