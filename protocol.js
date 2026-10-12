/** Convert DSH's provider-neutral GenerateOptions into OpenAI Chat Completions input. */
export function toChatRequest(options) {
  const messages = [];
  if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim()) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }

  for (const message of options.messages || []) {
    const role = message.role || message.type;
    const content = message.content ?? message.blocks ?? message.text;
    if (role === 'tool' || role === 'tool-result' || message.toolCallId || message.tool_call_id) {
      const callId = message.toolCallId || message.tool_call_id || message.id;
      if (!callId) throw new Error('DSH 工具结果缺少 toolCallId，无法转换为 OpenAI Chat Completions 格式。');
      messages.push({ role: 'tool', tool_call_id: callId, content: contentToText(content) });
      continue;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') continue;
    const output = { role, content: contentToText(content) };
    if (role === 'assistant') {
      const calls = collectToolCalls(content);
      if (calls.length) output.tool_calls = calls;
    }
    messages.push(output);
  }

  const request = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (Array.isArray(options.tools) && options.tools.length) {
    request.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters || tool.inputSchema || tool.input_schema || tool.schema || { type: 'object', properties: {} }
      }
    }));
  }
  if (typeof options.temperature === 'number') request.temperature = options.temperature;
  if (typeof options.topP === 'number') request.top_p = options.topP;
  if (typeof options.maxTokens === 'number') request.max_tokens = options.maxTokens;
  if (typeof options.maxOutputTokens === 'number' && request.max_tokens === undefined) request.max_tokens = options.maxOutputTokens;
  if (Array.isArray(options.stopSequences) && options.stopSequences.length) request.stop = options.stopSequences;
  if (typeof options.reasoning === 'string' && options.reasoning !== 'off') request.reasoning_effort = options.reasoning;
  if (request.tools) request.tool_choice = 'auto';
  return request;
}

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content == null) return '';
    if (typeof content?.text === 'string') return content.text;
    return String(content);
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image') throw new Error('当前版本的 AtomCode CodingPlan 插件尚未支持图像附件；请先使用文本输入。');
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'file') {
      const text = block.content;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

export function collectToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool-call' && block.name).map((block) => ({
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) }
  }));
}

export const __test = { toChatRequest, contentToText, collectToolCalls };
