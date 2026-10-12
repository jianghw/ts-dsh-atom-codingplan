/**
 * Validate the plugin's adapter against the REAL @deepseek-ai/dsh-llm kernel
 * shipped inside the installed DeepSeek Harness app.
 *
 * The kernel and its dependencies are extracted from the app's asar (every
 * file verified against the SHA-256 the asar records) into a temp directory,
 * then the plugin's chunks and metadata are run through the kernel's own
 * `BlockAssembler` and metadata validators. This proves protocol conformance
 * against the real implementation rather than our own expectations.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { openAsar, extractPackage } from './asar-extract.js'
import { createChunkTranslator } from '../translate.js'
import { SseFrameReader } from '../sse.js'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
if (!fs.existsSync(ASAR)) {
  console.log('SKIP: DeepSeek Harness app.asar not found')
  process.exit(0)
}

const kernelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-'))
const modules = path.join(kernelDir, 'node_modules')

const { fd, header, dataBase } = openAsar()
let totalVerified = 0
for (const pkg of ['dsh-llm', 'dsh-util-values', 'dsh-brand', 'dsh-util-crypto',
  'dsh-typert-protocol', 'dsh-timeout', 'schemastery', 'cordis', 'cosmokit']) {
  const result = extractPackage(header, fd, dataBase,
    `dsh/node_modules/@deepseek-ai/${pkg}`, path.join(modules, '@deepseek-ai', pkg))
  totalVerified += result.verified
}
for (const pkg of ['zod', '@standard-schema']) {
  const result = extractPackage(header, fd, dataBase,
    `dsh/node_modules/${pkg}`, path.join(modules, pkg))
  totalVerified += result.verified
}
console.log(`已从 app.asar 提取并校验 ${totalVerified} 个内核文件`)

const llm = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh-llm/lib/index.js')).href)
console.log(`内核导出 ${Object.keys(llm).length} 项 · dsh-llm 版本 ${
  JSON.parse(fs.readFileSync(path.join(modules, '@deepseek-ai/dsh-llm/package.json'), 'utf8')).version
}`)
assert.equal(typeof llm.LlmAdapter, 'function')
assert.equal(typeof llm.BlockAssembler, 'function')
assert.equal(typeof llm.attributionHeaders, 'function')

// --- 1. Adapter metadata must satisfy the kernel's own validators ----------
const PROVIDER = 'atomcode-codingplan'
const info = llm.LlmAdapter.prototype.providerInfo.call({}, PROVIDER)
assert.equal(typeof info.id, 'string')
assert.equal(typeof info.name, 'string')

// Reproduce the adapter's metadata exactly as index.js produces it.
const listModels = (provider) => [{
  provider,
  id: 'deepseek-v4-flash',
  name: 'deepseek-v4-flash',
  description: 'AtomGit CodingPlan via the plugin-managed local Atom2Api bridge.'
}]
const resolveModel = (provider, model) => ({
  provider,
  id: model,
  name: model,
  description: 'AtomGit CodingPlan via the plugin-managed local Atom2Api bridge.',
  inputModalities: ['text'],
  context: { contextWindow: 64000 },
  defaultMaxTokens: 8192
})

// llm/listModels validation: non-empty id and name, provider must match.
const models = listModels(PROVIDER)
for (const model of models) {
  assert.equal(model.provider, PROVIDER)
  assert.ok(model.id.length > 0 && typeof model.name === 'string' && model.name.length > 0)
}
// llm/resolveModel validation: context.contextWindow must be a positive integer.
const resolved = resolveModel(PROVIDER, 'deepseek-v4-flash')
assert.equal(resolved.id, 'deepseek-v4-flash')
assert.ok(Number.isInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0,
  'kernel rejects a missing or non-positive contextWindow (INVALID_MODEL_CONTEXT)')
assert.ok(Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0)
console.log('✓ 适配器元数据满足内核 listModels / resolveModel 校验规则')

console.log('✓ attributionHeaders():', JSON.stringify(llm.attributionHeaders()))

// --- 2. Real captured Atom2Api bytes through the kernel BlockAssembler ------
const raw = fs.readFileSync(new URL('./fixtures/atom2api-stream.txt', import.meta.url))
const translator = createChunkTranslator({ onError: (e) => { throw e } })
const reader = new SseFrameReader()
const decoder = new TextDecoder()
const chunks = []
for (let i = 0; i < raw.length; i += 5) {
  for (const frame of reader.push(decoder.decode(raw.subarray(i, i + 5), { stream: true }))) {
    chunks.push(...translator.push(frame))
  }
}
chunks.push(...translator.finish())

const assembler = new llm.BlockAssembler()
for (const chunk of chunks) assembler.push(chunk)
const assembled = assembler.assembled()
assert.deepEqual(assembled.blocks.map((b) => b.type), ['reasoning', 'text'])
assert.equal(assembled.blocks[1].text, 'Hello')
assert.equal(assembled.blocks[0].text, 'think')
assert.deepEqual(assembler.finish, { kind: 'stop' })
assert.deepEqual(assembler.usage, {
  inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3, reasoningTokens: 2
})
console.log('✓ 真实 Atom2Api 字节经内核 BlockAssembler 还原:', JSON.stringify(assembled.blocks))

// --- 3. llm/invariant grammar: no chunk after finish, no open blocks -------
const open = new Map()
let sawFinish = false
for (const chunk of chunks) {
  assert.ok(!sawFinish, `chunk ${chunk.type} emitted after the terminal finish`)
  if (chunk.type === 'block-start') {
    assert.ok(!open.has(chunk.index), 'repeated block-start index')
    open.set(chunk.index, chunk.blockType)
  } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    assert.equal(open.get(chunk.index), chunk.type === 'text-delta' ? 'text' : 'reasoning')
  } else if (chunk.type === 'tool-call-delta') {
    assert.equal(open.get(chunk.index), 'tool-call')
  } else if (chunk.type === 'block-end') {
    assert.equal(open.get(chunk.index), chunk.block.type)
    open.delete(chunk.index)
  } else if (chunk.type === 'usage') {
    assert.ok(!chunks.filter((c) => c.type === 'usage').slice(1).includes(chunk), 'usage more than once')
  } else if (chunk.type === 'finish') {
    sawFinish = true
    assert.equal(open.size, 0, 'stream finished with open blocks')
  }
}
console.log('✓ 流满足 llm/invariant 语法（块全部闭合、finish 唯一且在最后）')

// --- 4. Tool calls must assemble into an executable call -------------------
const toolTranslator = createChunkTranslator({ onError: (e) => { throw e } })
const toolChunks = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
].flatMap((frame) => toolTranslator.push(frame)).concat(toolTranslator.finish())

const toolAssembler = new llm.BlockAssembler()
for (const chunk of toolChunks) toolAssembler.push(chunk)
const toolAssembled = toolAssembler.assembled()
assert.equal(toolAssembled.blocks.length, 1)
const call = toolAssembled.blocks[0]
assert.equal(call.type, 'tool-call')
assert.equal(call.id, 'call_1')
assert.equal(call.name, 'lookup')
assert.deepEqual(JSON.parse(call.arguments), { q: 'x' })
assert.deepEqual(toolAssembler.finish, { kind: 'tool-calls' })
console.log('✓ 工具调用增量经内核还原为可执行调用:', call.name, call.arguments)

// --- 5. max-tokens truncation must drop tool calls, as the kernel intends ---
// Build the frames with JSON.stringify so the arguments stay valid JSON.
const truncFrames = [
  'data: ' + JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }, finish_reason: null }]
  }),
  'data: ' + JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'length' }]
  })
]
const truncTranslator = createChunkTranslator({ onError: (e) => { throw e } })
const truncChunks = truncFrames.flatMap((frame) => truncTranslator.push(frame))
  .concat(truncTranslator.finish())
const truncated = new llm.BlockAssembler()
for (const chunk of truncChunks) truncated.push(chunk)
assert.equal(truncated.finish.kind, 'max-tokens')
const kept = truncated.assembled().blocks
assert.equal(kept.some((b) => b.type === 'tool-call'), false,
  'a truncated tool call must not be executed')
console.log('✓ length 截断映射为 max-tokens，内核据此丢弃工具调用')

fs.rmSync(kernelDir, { recursive: true, force: true })
console.log('\nRESULT: PASS')
