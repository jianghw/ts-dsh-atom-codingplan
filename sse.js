/**
 * Atom2Api emits upstream SSE verbatim, one `data: {json}` line per event with
 * NO blank-line event terminator (verified against Atom2Api v1.0.9 darwin/arm64).
 * Standard EventSource framing would buffer the whole response and emit nothing.
 *
 * This parser therefore splits on a single newline and treats every `data:`
 * line as one self-contained event, while still tolerating the blank-line
 * delimited framing a conforming SSE server would send.
 */

/**
 * @param {string} raw - one decoded event, possibly containing several data lines
 * @returns {string|null} the joined data payload, or null when there is none
 */
export function extractDataPayload(raw) {
  const lines = raw.split('\n');
  const dataLines = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    // A single optional leading space after the colon is part of the framing.
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;
  const joined = dataLines.join('\n');
  return joined.trim() ? joined : null;
}

/**
 * Incremental SSE frame splitter tolerant of both line- and event-framed servers.
 *
 * Atom2Api never emits a blank-line terminator, so waiting for one to close an
 * event would stall the whole response. Each `data:` line is therefore its own
 * event, which matches Atom2Api exactly; blank lines from a conforming server
 * are simply ignored.
 */
export class SseFrameReader {
  constructor() {
    this.buffer = '';
  }

  /**
   * Feed decoded text and return any complete event payloads.
   * @param {string} text - newly decoded stream text
   * @returns {string[]} complete SSE event payloads, in arrival order
   */
  push(text) {
    this.buffer += text;
    const frames = [];
    let index;
    // `\r\n`, `\n\r`, and `\n` all terminate an SSE line; treat them uniformly.
    while ((index = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + (this.buffer.startsWith('\r\n', index) ? 2 : 1));
      if (line === '') continue; // blank line = event terminator, nothing to emit
      frames.push(line);
    }
    return frames;
  }

  /**
   * Drain a trailing event that arrived without its terminating newline.
   * @returns {string[]} any remaining complete payloads
   */
  flush() {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() ? [rest] : [];
  }
}

/** Map an OpenAI `finish_reason` onto the harness `FinishReason` vocabulary. */
export function finishReasonKind(reason) {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' };
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'content_filter':
      return { kind: 'error', failure: { code: 'CONTENT_FILTER', message: 'upstream refused the response content' } };
    default:
      return { kind: 'stop' };
  }
}
