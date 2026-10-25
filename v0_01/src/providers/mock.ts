/**
 * providers/mock.ts — a fake model for tests, demos and learning.
 *
 * You script the replies in advance; the agent loop cannot tell the
 * difference between this and a real API. This is how the test suite
 * exercises tool calling without network access or API keys, and it is a
 * great way to step through the loop in a debugger and watch it work.
 */

import type {
  AssistantMessage,
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
} from '../types.js';
import { ProviderError } from '../errors.js';

/**
 * Each scripted reply can be:
 *   • a string               → a final text answer
 *   • an `AssistantMessage`  → full control over content / tool calls
 *   • a `ProviderResponse`   → also control finishReason / usage
 *   • a function             → computed from the request (for assertions)
 */
export type MockReply =
  | string
  | AssistantMessage
  | ProviderResponse
  | ((request: ProviderRequest, callIndex: number) => MockReply);

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  /** Every request the agent sent, in order — assert on these in tests. */
  readonly requests: ProviderRequest[] = [];
  private readonly replies: MockReply[];

  constructor(replies: MockReply[]) {
    this.replies = [...replies];
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const index = this.requests.length;
    this.requests.push(request);

    const scripted = this.replies[index];
    if (scripted === undefined) {
      throw new ProviderError(this.name, `no scripted reply for call #${index + 1}`);
    }
    return normalize(resolve(scripted, request, index));
  }
}

function resolve(reply: MockReply, request: ProviderRequest, index: number): Exclude<MockReply, Function> {
  let current: MockReply = reply;
  // Allow functions to return functions (rare, but cheap to support).
  while (typeof current === 'function') current = current(request, index);
  return current;
}

function normalize(reply: Exclude<MockReply, Function>): ProviderResponse {
  if (typeof reply === 'string') {
    return { message: { role: 'assistant', content: reply }, finishReason: 'stop' };
  }
  if ('message' in reply && 'finishReason' in reply) {
    return reply;
  }
  const hasTools = !!reply.toolCalls && reply.toolCalls.length > 0;
  return { message: reply, finishReason: hasTools ? 'tool_calls' : 'stop' };
}

// ---------------------------------------------------------------------------
// Builders — make scripted replies read nicely in tests
// ---------------------------------------------------------------------------

let counter = 0;

/** An assistant message that calls one or more tools. */
export function toolCallMessage(
  ...calls: Array<{ name: string; args?: unknown; id?: string }>
): AssistantMessage {
  const toolCalls: ToolCall[] = calls.map((call) => ({
    id: call.id ?? `call_${++counter}`,
    name: call.name,
    arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
  }));
  return { role: 'assistant', content: null, toolCalls };
}
