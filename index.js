import Schema from '@deepseek-ai/schemastery';
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { AtomCodeBridge } from './bridge.js';
import { toChatRequest } from './protocol.js';
import { createChunkTranslator } from './translate.js';
import { SseFrameReader } from './sse.js';

const PROVIDER_ID = 'atomcode-codingplan';
const BOOTSTRAP_MODEL = 'deepseek-v4-flash';
/**
 * Atom2Api's `/v1/models` payload carries only `{id, object, created, owned_by}`,
 * so context metadata is not available on that route. 64000 matches the value
 * Atom2Api itself assigns to a model row with no reported context window.
 */
const FALLBACK_CONTEXT_WINDOW = 64000;
const DEFAULT_MAX_TOKENS = 8192;

export const name = 'dsh-atomcode-codingplan';
export const inject = ['llm'];
export const Config = Schema.object({});

class AtomCodeCodingPlanAdapter extends LlmAdapter {
  constructor(bridge) {
    super();
    this.bridge = bridge;
  }

  providerInfo(provider) {
    return { id: provider, name: 'AtomCode CodingPlan' };
  }

  async listModels(provider, signal) {
    try {
      const models = await this.bridge.getModels(signal);
      if (models.length) {
        return models.map((item) => ({
          provider,
          id: item.id,
          name: item.id,
          description: 'AtomGit CodingPlan via the plugin-managed local Atom2Api bridge.'
        }));
      }
    } catch (error) {
      console.warn(`[dsh-atomcode-codingplan] 读取模型目录失败：${error.message}`);
    }
    // Atom2Api only advertises a model once an account is attached to it, so an
    // unconnected bridge returns an empty catalog. Keep one selectable entry so
    // the picker still routes to us and the first call can trigger authorization.
    return [{
      provider,
      id: BOOTSTRAP_MODEL,
      name: 'DeepSeek V4 Flash（未授权，首次使用将引导登录）',
      description: '需要先完成 AtomGit CodingPlan 授权才能调用。'
    }];
  }

  async resolveModel(provider, model, signal) {
    let liveModel;
    try {
      liveModel = (await this.bridge.getModels(signal)).find((item) => item.id === model);
    } catch {}
    // `context.contextWindow` must be a positive integer or the kernel rejects
    // the whole model with INVALID_MODEL_CONTEXT; `name` must be non-empty.
    const contextWindow = Number.isInteger(liveModel?.context_length) && liveModel.context_length > 0
      ? liveModel.context_length
      : FALLBACK_CONTEXT_WINDOW;
    return {
      provider,
      id: model,
      name: model,
      description: 'AtomGit CodingPlan via the plugin-managed local Atom2Api bridge.',
      inputModalities: ['text'],
      context: { contextWindow },
      defaultMaxTokens: DEFAULT_MAX_TOKENS
    };
  }

  async *stream(options) {
    const bridge = this.bridge;
    let accounts = [];
    try { accounts = await bridge.getAccounts(); } catch {}
    if (!accounts.length) {
      await bridge.connectIfNeeded();
    }

    const body = toChatRequest(options);
    const authHeaders = typeof attributionHeaders === 'function' ? attributionHeaders() : {};
    const response = await bridge.chatCompletion({ body, attributionHeaders: authHeaders }, options.signal);
    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 3000);
      throw new LlmError(`AtomGit CodingPlan 返回 HTTP ${response.status}: ${errorText}`, 'PROVIDER_HTTP_ERROR');
    }
    if (!response.body) throw new LlmError('Atom2Api 未返回可读取的响应流。', 'PROVIDER_PROTOCOL_ERROR');

    const translator = createChunkTranslator({
      onError: (error) => {
        throw new LlmError(`Atom2Api 流式错误：${error.message}`, 'PROVIDER_STREAM_ERROR');
      }
    });

    const reader = new SseFrameReader();
    const decoder = new TextDecoder();
    const emit = function* (frames) {
      for (const frame of frames) {
        for (const chunk of translator.push(frame)) yield chunk;
      }
    };
    try {
      for await (const chunk of response.body) {
        yield* emit(reader.push(decoder.decode(chunk, { stream: true })));
      }
      yield* emit(reader.push(decoder.decode()));
      yield* emit(reader.flush());
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
        return;
      }
      throw error;
    }

    // Close every opened block before the terminal finish chunk: the kernel
    // invariant plugin rejects a stream that finishes with open blocks.
    yield* translator.finish();
  }
}

export function apply(ctx) {
  const bridge = new AtomCodeBridge();
  ctx.llm.registerAdapter([PROVIDER_ID], new AtomCodeCodingPlanAdapter(bridge));
  // Start the local bridge eagerly so the first chat request does not pay for a
  // binary download. Authentication stays user-driven and only begins when the
  // user sends a request or runs `setup`.
  void bridge.startSidecar().catch((error) => {
    console.warn(`[dsh-atomcode-codingplan] 本地桥接初始化失败：${error.message}`);
  });
}
