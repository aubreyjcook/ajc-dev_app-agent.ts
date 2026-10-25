import { describe, expect, it } from 'vitest';
import {
  Agent,
  InMemoryMemory,
  MaxStepsExceededError,
  MockProvider,
  defineTool,
  toolCallMessage,
  type AgentEvent,
} from '../src/index.js';

/** A tiny tool used across tests. */
const add = defineTool<{ a: number; b: number }, number>({
  name: 'add',
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute: ({ a, b }) => a + b,
});

describe('Agent.run — plain text', () => {
  it('returns the model text and persists the exchange', async () => {
    const provider = new MockProvider(['Hello back!']);
    const memory = new InMemoryMemory();
    const agent = new Agent({ provider, memory, systemPrompt: 'Be brief.' });

    const result = await agent.run('Hello', { conversationId: 'c1' });

    expect(result.text).toBe('Hello back!');
    expect(result.steps).toBe(1);
    expect(result.finishReason).toBe('stop');
    expect(result.newMessages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello back!' },
    ]);

    // System prompt is sent to the model but NOT stored in memory.
    expect(provider.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(await memory.load('c1')).toEqual(result.newMessages);
  });

  it('continues a stored conversation', async () => {
    const provider = new MockProvider(['first', 'second']);
    const agent = new Agent({ provider });

    const r1 = await agent.run('one');
    const r2 = await agent.run('two', { conversationId: r1.conversationId });

    expect(r2.messages).toHaveLength(4);
    // Second request includes the first exchange.
    expect(provider.requests[1]?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('accepts caller-supplied history (client-owned transcript)', async () => {
    const provider = new MockProvider(['ok']);
    const agent = new Agent({ provider });

    await agent.run('next', {
      history: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'earlier reply' },
      ],
    });

    expect(provider.requests[0]?.messages.map((m) => m.content)).toEqual([
      'earlier',
      'earlier reply',
      'next',
    ]);
  });
});

describe('Agent.run — tool calling', () => {
  it('runs a tool and feeds the result back to the model', async () => {
    const provider = new MockProvider([
      toolCallMessage({ name: 'add', args: { a: 2, b: 3 }, id: 'call_1' }),
      (request) => {
        // The second request must contain the tool result.
        const last = request.messages.at(-1);
        expect(last).toEqual({ role: 'tool', toolCallId: 'call_1', name: 'add', content: '5' });
        return 'The answer is 5.';
      },
    ]);
    const agent = new Agent({ provider, tools: [add] });

    const result = await agent.run('What is 2 + 3?');

    expect(result.text).toBe('The answer is 5.');
    expect(result.steps).toBe(2);
    expect(result.newMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // Tool specs are sent without `execute`.
    expect(provider.requests[0]?.tools).toEqual([
      { name: 'add', description: 'Add two numbers', parameters: add.parameters },
    ]);
  });

  it('handles multiple tool calls in one step, in order', async () => {
    const provider = new MockProvider([
      toolCallMessage(
        { name: 'add', args: { a: 1, b: 1 }, id: 'x' },
        { name: 'add', args: { a: 10, b: 5 }, id: 'y' },
      ),
      'done',
    ]);
    const agent = new Agent({ provider, tools: [add] });

    const result = await agent.run('go');
    const toolMessages = result.newMessages.filter((m) => m.role === 'tool');

    expect(toolMessages).toEqual([
      { role: 'tool', toolCallId: 'x', name: 'add', content: '2' },
      { role: 'tool', toolCallId: 'y', name: 'add', content: '15' },
    ]);
  });

  it('reports unknown tools and tool errors back to the model instead of throwing', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'always fails',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        throw new Error('kaboom');
      },
    });
    const provider = new MockProvider([
      toolCallMessage({ name: 'nope', id: 'a' }, { name: 'boom', id: 'b' }, { name: 'add', args: 'not json', id: 'c' }),
      'recovered',
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, tools: [add, boom], onEvent: (e) => events.push(e) });

    const result = await agent.run('go');

    expect(result.text).toBe('recovered');
    const toolMessages = result.newMessages.filter((m) => m.role === 'tool');
    expect(toolMessages[0]?.content).toContain('Unknown tool "nope"');
    expect(toolMessages[1]?.content).toContain('kaboom');
    expect(toolMessages[2]?.content).toContain('not valid JSON');
    expect(events.filter((e) => e.type === 'tool:error')).toHaveLength(3);
  });

  it('stops with MaxStepsExceededError on an endless tool loop', async () => {
    const forever = Array.from({ length: 10 }, () => toolCallMessage({ name: 'add', args: { a: 0, b: 0 } }));
    const provider = new MockProvider(forever);
    const memory = new InMemoryMemory();
    const agent = new Agent({ provider, tools: [add], maxSteps: 3, memory });

    await expect(agent.run('loop', { conversationId: 'c' })).rejects.toBeInstanceOf(MaxStepsExceededError);
    expect(provider.requests).toHaveLength(3);
    // Partial progress was persisted and is well-formed (every call has a result).
    const stored = await memory.load('c');
    expect(stored.filter((m) => m.role === 'assistant')).toHaveLength(3);
    expect(stored.filter((m) => m.role === 'tool')).toHaveLength(3);
  });
});

describe('Agent — events and cancellation', () => {
  it('emits lifecycle events in order', async () => {
    const provider = new MockProvider([toolCallMessage({ name: 'add', args: { a: 1, b: 2 } }), 'ok']);
    const events: string[] = [];
    const agent = new Agent({ provider, tools: [add], onEvent: (e) => events.push(e.type) });

    await agent.run('hi');

    expect(events).toEqual([
      'run:start',
      'step:start',
      'llm:request',
      'llm:response',
      'tool:start',
      'tool:end',
      'step:start',
      'llm:request',
      'llm:response',
      'run:end',
    ]);
  });

  it('a throwing event handler does not break the run', async () => {
    const agent = new Agent({
      provider: new MockProvider(['fine']),
      onEvent: () => {
        throw new Error('observer bug');
      },
    });
    await expect(agent.run('x')).resolves.toMatchObject({ text: 'fine' });
  });

  it('honours an already-aborted signal', async () => {
    const provider = new MockProvider(['never']);
    const agent = new Agent({ provider });
    const controller = new AbortController();
    controller.abort();

    await expect(agent.run('x', { signal: controller.signal })).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects invalid maxSteps', () => {
    expect(() => new Agent({ provider: new MockProvider([]), maxSteps: 0 })).toThrow(/maxSteps/);
  });
});
