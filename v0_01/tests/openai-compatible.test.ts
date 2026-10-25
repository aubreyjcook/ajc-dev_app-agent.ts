import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleProvider,
  ProviderError,
  fromWireResponse,
  toWireRequest,
  type ProviderRequest,
} from '../src/index.js';

/** Build a fake `fetch` that records the call and returns a canned response. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe('toWireRequest', () => {
  it('maps every message role and tool specs to the OpenAI shape', () => {
    const request: ProviderRequest = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'add', arguments: '{"a":1}' }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'add', content: '2' },
      ],
      tools: [{ name: 'add', description: 'adds', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 100,
    };

    expect(toWireRequest(request, 'default-model')).toEqual({
      model: 'default-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":1}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '2' },
      ],
      tools: [{ type: 'function', function: { name: 'add', description: 'adds', parameters: { type: 'object' } } }],
      temperature: 0.2,
      max_tokens: 100,
    });
  });

  it('prefers a per-request model and omits empty tools', () => {
    const wire = toWireRequest({ messages: [], model: 'override', tools: [] }, 'default');
    expect(wire.model).toBe('override');
    expect(wire).not.toHaveProperty('tools');
  });
});

describe('fromWireResponse', () => {
  it('parses a text reply with usage', () => {
    const out = fromWireResponse(
      {
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      'test',
    );
    expect(out.message).toEqual({ role: 'assistant', content: 'hello' });
    expect(out.finishReason).toBe('stop');
    expect(out.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('parses tool calls and forces finishReason to tool_calls', () => {
    const out = fromWireResponse(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'x', type: 'function', function: { name: 'add', arguments: '{}' } }],
            },
            finish_reason: 'stop', // some servers do this
          },
        ],
      },
      'test',
    );
    expect(out.finishReason).toBe('tool_calls');
    expect(out.message.toolCalls).toEqual([{ id: 'x', name: 'add', arguments: '{}' }]);
  });

  it('throws ProviderError on a malformed body', () => {
    expect(() => fromWireResponse({ nope: true }, 'test')).toThrow(ProviderError);
  });
});

describe('OpenAICompatibleProvider.complete', () => {
  it('POSTs to /chat/completions with auth header and returns the parsed reply', async () => {
    const { impl, calls } = fakeFetch(200, {
      choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
    });
    const provider = new OpenAICompatibleProvider({
      model: 'm',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1/', // trailing slash should be tolerated
      headers: { 'x-extra': '1' },
      fetch: impl,
    });

    const out = await provider.complete({ messages: [{ role: 'user', content: 'ping' }] });

    expect(out.message.content).toBe('pong');
    expect(calls[0]?.url).toBe('https://example.test/v1/chat/completions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
      'x-extra': '1',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'm' });
  });

  it('omits the auth header when no apiKey is given (local servers)', async () => {
    const { impl, calls } = fakeFetch(200, { choices: [{ message: { content: 'x' } }] });
    const provider = new OpenAICompatibleProvider({ model: 'm', fetch: impl });
    await provider.complete({ messages: [] });
    expect(calls[0]?.init.headers).not.toHaveProperty('authorization');
  });

  it('throws ProviderError with status and body on HTTP errors', async () => {
    const { impl } = fakeFetch(429, { error: { message: 'rate limited' } });
    const provider = new OpenAICompatibleProvider({ model: 'm', fetch: impl });

    const err = await provider.complete({ messages: [] }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(429);
    expect((err as ProviderError).body).toEqual({ error: { message: 'rate limited' } });
    expect((err as ProviderError).message).toContain('rate limited');
  });

  it('wraps network failures in ProviderError but passes aborts through', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const p1 = new OpenAICompatibleProvider({ model: 'm', fetch: failing });
    await expect(p1.complete({ messages: [] })).rejects.toBeInstanceOf(ProviderError);

    const aborting = (async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    const p2 = new OpenAICompatibleProvider({ model: 'm', fetch: aborting });
    await expect(p2.complete({ messages: [] })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
