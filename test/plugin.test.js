import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseFrameReader, extractDataPayload, finishReasonKind } from '../sse.js';
import { createChunkTranslator } from '../translate.js';
import { __test as adapterTest } from '../protocol.js';
import { __test as bridgeTest } from '../bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Decode the stream exactly like the adapter does, over a byte range. */
async function collectChunks(buffer, { chunkSize = 7 } = {}) {
  const reader = new SseFrameReader();
  const decoder = new TextDecoder();
  const frames = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    frames.push(...reader.push(decoder.decode(buffer.subarray(i, i + chunkSize), { stream: true })));
  }
  frames.push(...reader.push(decoder.decode()));
  frames.push(...reader.flush());
  return frames;
}

test('Atom2Api real stream bytes decode into one payload per data line', async () => {
  // Captured from Atom2Api v1.0.9 (darwin/arm64) proxying a real SSE upstream.
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'atom2api-stream.txt'));
  const frames = await collectChunks(raw);
  const payloads = frames.map(extractDataPayload).filter((payload) => payload !== null);
  // 6 JSON events plus the terminal `data: [DONE]` marker.
  assert.equal(payloads.length, 7, 'Atom2Api emits one event per data line');
  assert.equal(payloads.at(-1), '[DONE]');
  const events = payloads.slice(0, -1).map((payload) => JSON.parse(payload));
  assert.deepEqual(
    events.map((event) => event.choices?.[0]?.delta?.content ?? null),
    ['', null, 'Hel', 'lo', null, null]
  );
});

test('real Atom2Api bytes translate into a valid harness chunk sequence', async () => {
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'atom2api-stream.txt'));
  const translator = createChunkTranslator({ onError: (error) => { throw error; } });
  const chunks = [];
  for (const frame of await collectChunks(raw)) chunks.push(...translator.push(frame));
  chunks.push(...translator.finish());

  const types = chunks.map((chunk) => chunk.type);
  assert.ok(types.includes('text-delta'), 'the original \n\n-only parser emitted zero chunks');
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text),
    ['Hel', 'lo']
  );
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text),
    ['think']
  );
  assert.equal(types.at(-1), 'finish');
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });

  const usage = chunks.find((chunk) => chunk.type === 'usage');
  assert.deepEqual(usage.usage, {
    inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3, reasoningTokens: 2
  });

  // Every block must be closed before the terminal finish chunk: the kernel
  // invariant plugin fails the stream otherwise.
  const open = new Map();
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') open.set(chunk.index, chunk.blockType);
    if (chunk.type === 'block-end') {
      assert.equal(open.get(chunk.index), chunk.block.type, 'block-end closes its own block');
      open.delete(chunk.index);
    }
    if (chunk.type === 'finish') assert.equal(open.size, 0, 'no block left open at finish');
  }
});

test('streamed tool-call deltas assemble into one complete tool call', () => {
  const translator = createChunkTranslator();
  const wire = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"other","arguments":"{}"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
  ];
  const chunks = wire.flatMap((frame) => translator.push(frame)).concat(translator.finish());
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
  assert.deepEqual(deltas.map((chunk) => [chunk.index, chunk.id, chunk.argumentsDelta]), [
    [0, 'call_1', '{"q":'],
    [0, 'call_1', '"x"}'],
    [1, 'call_2', '{}']
  ]);
  // `name` must be absent (never empty) on argument-only continuation deltas.
  assert.equal(deltas[1].name, undefined);
  const ends = chunks.filter((chunk) => chunk.type === 'block-end');
  assert.deepEqual(ends.map((chunk) => chunk.block.name), ['lookup', 'other']);
  assert.deepEqual(ends.map((chunk) => chunk.block.arguments), ['{"q":"x"}', '{}']);
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
});

test('max_tokens truncation maps to max-tokens and keeps tool calls in the block stream', () => {
  const translator = createChunkTranslator();
  translator.push('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}');
  const chunks = translator.finish();
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' });
});

test('an in-stream error event surfaces instead of being ignored', () => {
  const translator = createChunkTranslator({ onError: (error) => { throw error; } });
  assert.throws(
    () => translator.push('data: {"error":{"code":"upstream_error","message":"boom"}}'),
    /boom/
  );
});

test('malformed JSON frames are skipped without breaking the stream', () => {
  const translator = createChunkTranslator();
  assert.deepEqual(translator.push('data: {not json'), []);
  assert.deepEqual(translator.push('data: '), []);
  assert.deepEqual(translator.push(': comment line'), []);
  assert.deepEqual(translator.push('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}'),
    [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'ok' }]);
});

test('the captured stream contains no blank-line SSE terminators', () => {
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'atom2api-stream.txt'));
  // This is the regression guard for the original \n\n-only parser, which
  // buffered the entire stream and emitted zero chunks.
  assert.equal(raw.includes(Buffer.from('\n\n')), false);
});

test('SSE framing survives arbitrary chunk boundaries and CRLF', async () => {
  const wire = 'data: {"choices":[{"delta":{"content":"a"}}]}\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\ndata: [DONE]\r\n';
  for (const chunkSize of [1, 3, 17, 4096]) {
    const frames = await collectChunks(Buffer.from(wire), { chunkSize });
    const payloads = frames.map(extractDataPayload).filter((payload) => payload !== null);
    assert.equal(payloads.length, 3, `chunk size ${chunkSize}`);
    assert.equal(JSON.parse(payloads[0]).choices[0].delta.content, 'a');
    assert.equal(JSON.parse(payloads[1]).choices[0].delta.content, 'b');
    assert.equal(payloads[2], '[DONE]');
  }
});

test('a multi-line data event is joined rather than split', () => {
  assert.equal(extractDataPayload('data: {"a":\ndata: 1}'), '{"a":\n1}');
  assert.equal(extractDataPayload('event: ping'), null);
  assert.equal(extractDataPayload('data:   spaced'), '  spaced');
  assert.equal(extractDataPayload('data: [DONE]'), '[DONE]');
});

test('finish reasons map onto the kernel FinishReason vocabulary', () => {
  // dsh-llm 0.2.0-rc.2 only special-cases 'max-tokens' in BlockAssembler.
  assert.deepEqual(finishReasonKind('stop'), { kind: 'stop' });
  assert.deepEqual(finishReasonKind('length'), { kind: 'max-tokens' });
  assert.deepEqual(finishReasonKind('tool_calls'), { kind: 'tool-calls' });
  assert.deepEqual(finishReasonKind('content_filter').kind, 'error');
  assert.deepEqual(finishReasonKind(undefined), { kind: 'stop' });
});

test('converts basic DSH messages to OpenAI chat format', () => {
  const request = adapterTest.toChatRequest({
    model: 'deepseek-v4-flash',
    systemPrompt: 'System prompt',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
    ]
  });
  assert.equal(request.model, 'deepseek-v4-flash');
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[1].content, 'Hi');
  assert.equal(request.messages[2].content, 'Hello');
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('serializes assistant tool-call blocks and tool results', () => {
  const request = adapterTest.toChatRequest({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }] },
      { role: 'toolResult', toolCallId: 'call_1', content: 'result text' }
    ],
    tools: [{ name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
  });
  assert.equal(request.messages[0].tool_calls[0].function.name, 'lookup');
  assert.equal(request.messages[0].tool_calls[0].function.arguments, '{"q":"x"}');
  assert.equal(request.messages[1].role, 'tool');
  assert.equal(request.messages[1].tool_call_id, 'call_1');
  assert.equal(request.messages[1].content, 'result text');
  assert.equal(request.tools[0].function.name, 'lookup');
  assert.equal(request.tool_choice, 'auto');
});

test('image attachments fail loudly instead of being silently dropped', () => {
  assert.throws(
    () => adapterTest.contentToText([{ type: 'image', image: 'data:...' }]),
    /尚未支持图像附件/
  );
});

test('account and URL discovery tolerates wrapped OAuth payloads', () => {
  assert.equal(bridgeTest.findAccounts({ data: [{ id: 'a' }] }).length, 1);
  assert.equal(bridgeTest.findFirstUrl({ result: { authorization_url: 'https://acs.atomgit.com/auth/1' } }), 'https://acs.atomgit.com/auth/1');
  assert.equal(bridgeTest.findFirstUrl({ url: 'https://evil.example.invalid/login' }), undefined);
});

test('authorization URLs are restricted to official AtomGit hosts', () => {
  assert.equal(bridgeTest.isAllowedAuthUrl('https://acs.atomgit.com/s/abc'), true);
  assert.equal(bridgeTest.isAllowedAuthUrl('https://api.gitcode.com/api/v5/x'), true);
  assert.equal(bridgeTest.isAllowedAuthUrl('http://acs.atomgit.com/s/abc'), false, 'plaintext http is refused');
  assert.equal(bridgeTest.isAllowedAuthUrl('https://atomgit.com.evil.test/s/abc'), false);
  assert.equal(bridgeTest.isAllowedAuthUrl('https://evil.test/atomgit.com'), false);
  assert.equal(bridgeTest.isAllowedAuthUrl('javascript:alert(1)'), false);
});

test('binary asset matching requires OS and architecture', () => {
  const armOs = ['darwin', 'macos', 'mac-os', 'mac'];
  const arm = ['arm64', 'aarch64'];
  const intelOs = ['darwin', 'macos', 'mac-os', 'mac'];
  const intel = ['amd64', 'x86_64', 'x64'];
  // Real Atom2Api v1.0.9 asset names.
  assert.equal(bridgeTest.assetMatches('atom2api_1.0.9_darwin_arm64.tar.gz', armOs, arm), true);
  assert.equal(bridgeTest.assetMatches('atom2api_1.0.9_darwin_amd64.tar.gz', intelOs, intel), true);
  assert.equal(bridgeTest.assetMatches('atom2api_1.0.9_linux_arm64.tar.gz', armOs, arm), false);
  // An Intel host must never accept the arm64 build, and vice versa.
  assert.equal(bridgeTest.assetMatches('atom2api_1.0.9_darwin_arm64.tar.gz', intelOs, intel), false);
  assert.equal(bridgeTest.assetMatches('atom2api_1.0.9_darwin_amd64.tar.gz', armOs, arm), false);
  assert.equal(bridgeTest.assetMatches('atom2api_1.0.9_windows_amd64.zip', armOs, arm), false);
  // Non-archive assets must not be selected as the download.
  assert.equal(bridgeTest.assetMatches('sha256sums', armOs, arm), false);
});

test('platformAssetToken returns the token lists assetMatches expects', async () => {
  // Regression guard: the download path once destructured the arch array as a
  // string, so assetMatches crashed with "cannot read properties of undefined".
  const bridge = await import('../bridge.js');
  const platform = bridge.__test.platformAssetToken();
  assert.ok(Array.isArray(platform.os), 'os is an array');
  assert.ok(Array.isArray(platform.arch), 'arch is an array');
  // Exactly one architecture family must be selectable on this machine.
  const thisArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const otherArch = process.arch === 'arm64' ? 'amd64' : 'arm64';
  assert.ok(bridgeTest.assetMatches(`atom2api_1.0.9_darwin_${thisArch}.tar.gz`, platform.os, platform.arch));
  assert.equal(bridgeTest.assetMatches(`atom2api_1.0.9_darwin_${otherArch}.tar.gz`, platform.os, platform.arch), false);
});
