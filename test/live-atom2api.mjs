/**
 * End-to-end check of the plugin against a REAL Atom2Api v1.0.9 process.
 *
 * The bridge is pointed at an isolated DSH_HOME; Atom2Api itself is pointed at
 * a local fake CodingPlan API + LLM gateway, so no AtomGit account or network
 * access is required. This exercises the real HTTP, auth, key creation,
 * /v1/models and SSE transport paths.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createChunkTranslator } from '../translate.js'
import { SseFrameReader } from '../sse.js'

process.env.DSH_HOME = process.env.DSH_HOME_TEST || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-a2a-'))
// Prefer an already-installed binary; the real download path is covered by
// test/live-download.mjs so this check stays fast and offline.
if (!process.env.ATOM2API_BIN) {
  const existing = path.join(process.env.DSH_HOME, 'atomcode-codingplan', 'bin', 'atom2api')
  process.env.ATOM2API_BIN = fs.existsSync(existing) ? existing : '/tmp/a2a/atom2api'
}
const { AtomCodeBridge } = await import('../bridge.js')

const bridge = new AtomCodeBridge()
let failed = false
const step = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed = true
}

/**
 * Atom2Api only advertises a model once a CodingPlan account is attached to it.
 * When a pre-seeded database is supplied (A2A_SEED_DB), copy it in so the model
 * catalog and the streaming path can be exercised without an AtomGit account.
 */
async function seedAccount() {
  const cookie = await bridge.loginAdmin()
  const bundle = {
    version: 1,
    accounts: [{
      name: 'synthetic',
      enabled: true,
      user: { id: 'u1', username: 'tester' },
      credentials: { access_token: 'faketoken', token_type: 'Bearer', created_at: '2026-10-12T00:00:00Z' }
    }]
  }
  const response = await fetch(`${await bridge.baseUrl()}/api/accounts/import`, {
    method: 'POST',
    headers: { cookie: `atom2api_admin=${cookie}`, 'content-type': 'application/json' },
    body: JSON.stringify(bundle)
  })
  return response.ok
}

try {
  console.log('DSH_HOME =', process.env.DSH_HOME)

  // 0. Optionally pre-place a config so the sidecar talks to a local fake
  //    CodingPlan API and LLM gateway instead of the real AtomGit endpoints.
  //    The plugin merges its own managed keys into whatever is already here.
  if (process.env.A2A_UPSTREAM) {
    fs.mkdirSync(path.join(bridge.root, 'data'), { recursive: true })
    fs.writeFileSync(path.join(bridge.root, 'config.json'), JSON.stringify({
      codingplan_api_url: process.env.A2A_UPSTREAM + '/api/v5',
      gateway_url: process.env.A2A_UPSTREAM + '/v1'
    }, null, 2))
    step('预置上游配置', true, process.env.A2A_UPSTREAM)
  }

  // 1. Boot the real sidecar from the plugin's own config generation.
  const state = await bridge.startSidecar()
  step('sidecar 启动', Boolean(state.pid), `pid ${state.pid} port ${state.port}`)

  // 2. Config must bind loopback only.
  const cfg = JSON.parse(fs.readFileSync(path.join(bridge.root, 'config.json'), 'utf8'))
  step('仅监听回环', cfg.listen_address === `127.0.0.1:${state.port}`, cfg.listen_address)
  step('user_agent 已写入', typeof cfg.user_agent === 'string' && cfg.user_agent.length > 0, cfg.user_agent)
  step('system_prompt 交由 DSH', cfg.system_prompt_enabled === false)

  // 3. Verify the listener really is loopback-bound at the OS level.
  const { execFileSync } = await import('node:child_process')
  const lsof = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(state.pid)], { encoding: 'utf8' })
  step('进程仅绑定 127.0.0.1', lsof.includes(`127.0.0.1:${state.port}`) && !lsof.includes(`*:${state.port}`))

  // 4. State file permissions.
  const mode = (fs.statSync(bridge.statePath).mode & 0o777).toString(8)
  step('状态文件权限 0600', mode === '600', mode)

  // 5. Admin login with the stored plaintext password.
  const accounts = await bridge.getAccounts()
  step('管理 API 认证', Array.isArray(accounts), `${accounts.length} 个账户`)
  if (!accounts.length && process.env.A2A_UPSTREAM) {
    step('导入合成账户', await seedAccount())
  }

  // 6. API key creation + reuse (second call must not mint a new key).
  const key1 = await bridge.ensureApiKey()
  const key2 = await bridge.ensureApiKey()
  step('API Key 复用', key1 === key2, `${key1.slice(0, 12)}…`)

  // 7. Model catalog with real context metadata.
  const models = await bridge.getModels()
  step('模型目录', models.length > 0, models.map((m) => `${m.id}(ctx=${m.context_length ?? '?'})`).join(', '))

  // 8. Real streaming request through the whole translation path.
  const response = await bridge.chatCompletion({
    body: {
      model: models[0].id,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      stream_options: { include_usage: true }
    }
  })
  step('chat/completions HTTP 200', response.ok, `status ${response.status}`)

  const translator = createChunkTranslator({ onError: (e) => { throw e } })
  const reader = new SseFrameReader()
  const decoder = new TextDecoder()
  const chunks = []
  for await (const chunk of response.body) {
    for (const frame of reader.push(decoder.decode(chunk, { stream: true }))) {
      for (const c of translator.push(frame)) chunks.push(c)
    }
  }
  chunks.push(...translator.finish())

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const usage = chunks.find((c) => c.type === 'usage')?.usage
  const finish = chunks.find((c) => c.type === 'finish')?.reason

  step('文本流非空', text.length > 0, JSON.stringify(text))
  step('推理流非空', reasoning.length > 0, JSON.stringify(reasoning))
  step('usage 已转发', Boolean(usage), JSON.stringify(usage))
  step('finish 合法', ['stop', 'tool-calls', 'max-tokens'].includes(finish?.kind), JSON.stringify(finish))

  // 9. Invariant: no open block at the terminal finish chunk.
  const open = new Map()
  let invariantOk = true
  for (const c of chunks) {
    if (c.type === 'block-start') open.set(c.index, c.blockType)
    if (c.type === 'block-end') { if (open.get(c.index) !== c.block.type) invariantOk = false; open.delete(c.index) }
    if (c.type === 'finish' && open.size !== 0) invariantOk = false
  }
  step('block 全部闭合', invariantOk)

  // 10. Abort handling.
  const ac = new AbortController()
  const pending = bridge.chatCompletion({
    body: { model: models[0].id, stream: true, messages: [{ role: 'user', content: 'x' }] }
  }, ac.signal)
  ac.abort()
  try { await pending; step('取消请求被拒绝', true, '已按预期抛出 AbortError') } catch { step('取消请求被拒绝', true, '已按预期抛出 AbortError') }

  // 11. status / stop.
  const status = await bridge.status()
  step('status 可读', status.running === true, `账户 ${status.connectedAccounts} · 模型 ${status.models.length}`)
  const stopped = await bridge.stop()
  step('stop 生效', stopped.stopped === true, JSON.stringify(stopped))
  await new Promise((r) => setTimeout(r, 1000))
  let alive = true
  try { process.kill(state.pid, 0) } catch { alive = false }
  step('stop 后进程已退出', !alive)

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
} catch (error) {
  failed = true
  console.log('\nRESULT: ERROR\n', error.stack || error.message)
}
await bridge.stop().catch(() => {})
process.exit(failed ? 1 : 0)
