/**
 * Translate OpenAI Chat Completions streaming events into the harness
 * `StreamChunk` vocabulary.
 *
 * This is kept free of `dsh-llm` imports and HTTP so the exact chunk sequence
 * can be asserted against bytes captured from a real Atom2Api instance.
 */

import { extractDataPayload, finishReasonKind } from './sse.js';

/**
 * @param {object} [options]
 * @param {(error: Error) => never} [options.onError] - classify a stream error
 * @param {string} [options.syntheticIdPrefix] - prefix for generated tool ids
 */
export function createChunkTranslator(options = {}) {
  const onError = options.onError ?? ((error) => { throw error; });
  const state = {
    contentIndex: null,
    contentText: '',
    reasoningIndex: null,
    reasoningText: '',
    nextBlockIndex: 0,
    tools: new Map(),
    usageEmitted: false,
    finish: null,
    toolSequence: 0
  };

  /** @param {string} raw - one SSE frame @returns {object[]} harness chunks */
  function push(raw) {
    const data = extractDataPayload(raw);
    if (!data || data === '[DONE]') return [];
    let event;
    try { event = JSON.parse(data); } catch { return []; }
    if (!event || typeof event !== 'object') return [];

    const chunks = [];

    if (event.error) {
      const message = typeof event.error === 'string'
        ? event.error
        : (event.error?.message ?? JSON.stringify(event.error));
      onError(new Error(message));
      return chunks;
    }

    const usage = event.usage;
    if (usage && !state.usageEmitted) {
      state.usageEmitted = true;
      const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
      const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
      const cacheReadTokens = Number(usage.prompt_tokens_details?.cached_tokens);
      const cacheWriteTokens = Number(usage.prompt_tokens_details?.cache_creation_tokens);
      const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens);
      chunks.push({
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(Number.isFinite(cacheReadTokens) ? { cacheReadTokens } : {}),
          ...(Number.isFinite(cacheWriteTokens) ? { cacheWriteTokens } : {}),
          ...(Number.isFinite(reasoningTokens) ? { reasoningTokens } : {})
        }
      });
    }

    const choice = event.choices?.[0];
    if (!choice) return chunks;
    const delta = choice.delta || {};

    const reasoning = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    if (reasoning) {
      if (state.reasoningIndex === null) {
        state.reasoningIndex = state.nextBlockIndex++;
        chunks.push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' });
      }
      state.reasoningText += reasoning;
      chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: reasoning });
    }

    const content = typeof delta.content === 'string' ? delta.content : '';
    if (content) {
      if (state.contentIndex === null) {
        state.contentIndex = state.nextBlockIndex++;
        chunks.push({ type: 'block-start', index: state.contentIndex, blockType: 'text' });
      }
      state.contentText += content;
      chunks.push({ type: 'text-delta', index: state.contentIndex, text: content });
    }

    for (const toolDelta of delta.tool_calls || []) {
      if (!toolDelta || typeof toolDelta !== 'object') continue;
      const toolIndex = Number.isInteger(toolDelta.index) ? toolDelta.index : state.tools.size;
      let tool = state.tools.get(toolIndex);
      if (!tool) {
        tool = {
          index: state.nextBlockIndex++,
          id: typeof toolDelta.id === 'string' && toolDelta.id
            ? toolDelta.id
            : `${options.syntheticIdPrefix ?? 'atomcode-call'}-${state.toolSequence++}`,
          name: '',
          arguments: ''
        };
        state.tools.set(toolIndex, tool);
        chunks.push({ type: 'block-start', index: tool.index, blockType: 'tool-call' });
      }
      if (typeof toolDelta.id === 'string' && toolDelta.id) tool.id = toolDelta.id;
      // Only the first chunk carries the function name; later ones only append
      // argument fragments. An empty `name` would be read as "not yet named".
      const namePart = typeof toolDelta.function?.name === 'string' ? toolDelta.function.name : '';
      if (namePart) tool.name += namePart;
      const argumentPart = typeof toolDelta.function?.arguments === 'string' ? toolDelta.function.arguments : '';
      if (argumentPart) tool.arguments += argumentPart;
      chunks.push({
        type: 'tool-call-delta',
        index: tool.index,
        id: tool.id,
        ...(namePart ? { name: namePart } : {}),
        argumentsDelta: argumentPart
      });
    }

    if (choice.finish_reason) state.finish = finishReasonKind(choice.finish_reason);
    return chunks;
  }

  /**
   * Close every open block and emit the single terminal finish chunk.
   * The kernel invariant plugin rejects a stream that finishes with open blocks.
   * @returns {object[]} closing and terminal chunks
   */
  function finish() {
    const chunks = [];
    if (state.contentIndex !== null) {
      chunks.push({ type: 'block-end', index: state.contentIndex, block: { type: 'text', text: state.contentText } });
    }
    if (state.reasoningIndex !== null) {
      chunks.push({ type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoningText } });
    }
    for (const tool of state.tools.values()) {
      chunks.push({
        type: 'block-end',
        index: tool.index,
        block: { type: 'tool-call', id: tool.id, name: tool.name || 'unknown_tool', arguments: tool.arguments || '{}' }
      });
    }
    chunks.push({ type: 'finish', reason: state.finish ?? { kind: 'stop' } });
    return chunks;
  }

  return { push, finish, state };
}
