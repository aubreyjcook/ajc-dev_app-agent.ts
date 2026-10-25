# @ajc-dev/app-agent — v0_01

A bare-bones, **zero-runtime-dependency** TypeScript agent loop you can drop into any website or web app
to give it an "agentic" feature: a model that can reason, call your functions, read the results, and
answer. Built with Next.js in mind, but it only needs `fetch`, so it runs anywhere JavaScript does.

> **Status: alpha.** APIs will change between `v0_0x` versions. Each version directory is self-contained
> and documents what changed (`CHANGELOG.md`) and what is next (`ROADMAP.md`).

## What you get

| Piece | File | One-liner |
| --- | --- | --- |
| `Agent` | `src/agent.ts` | The loop: call model → run tools → repeat → return text |
| `defineTool` / `ToolRegistry` | `src/tool.ts` | Declare functions the model may call |
| `LLMProvider` interface | `src/types.ts` | The *only* thing a model backend must implement |
| `OpenAICompatibleProvider` | `src/providers/openai-compatible.ts` | Works with OpenAI, DeepSeek, Groq, OpenRouter, Ollama, … |
| `MockProvider` | `src/providers/mock.ts` | Scripted fake model for tests and learning |
| `InMemoryMemory` / `NullMemory` | `src/memory.ts` | Where conversation history lives |
| Typed errors | `src/errors.ts` | `ProviderError`, `ToolExecutionError`, `MaxStepsExceededError`, … |
| Events | `AgentOptions.onEvent` | Observe every step, model call and tool call |

## Quick start

```bash
cd v0_01
pnpm install
pnpm test        # 31 tests, no network needed
pnpm build       # emits dist/ (ESM + .d.ts)
```

```ts
import { Agent, OpenAICompatibleProvider, defineTool } from '@ajc-dev/app-agent';

// 1. A tool: name + description + JSON Schema + the function itself.
const getWeather = defineTool<{ city: string }, string>({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => `It is sunny in ${city}.`, // call a real API here
});

// 2. A provider: any OpenAI-style endpoint.
const provider = new OpenAICompatibleProvider({
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
  // baseUrl: 'http://localhost:11434/v1',   // e.g. Ollama
});

// 3. The agent.
const agent = new Agent({
  provider,
  tools: [getWeather],
  systemPrompt: 'You are a helpful assistant.',
});

const result = await agent.run('What is the weather in Paris?');
console.log(result.text);   // "It is sunny in Paris."
console.log(result.steps);  // 2  (one call that asked for the tool, one that answered)
```

## Conversations

LLM APIs are stateless, so *you* decide where history lives. Two patterns, both supported:

**Server owns history** — pass a `conversationId`; the agent loads/saves through `Memory`
(default `InMemoryMemory`, fine for dev; implement `Memory` against your DB for production).

```ts
const a = await agent.run('My name is Aubrey.', { conversationId: 'user-42' });
const b = await agent.run('What is my name?', { conversationId: 'user-42' }); // remembers
```

**Client owns history** — the browser sends the whole transcript each time; use `NullMemory`
and pass `history`. This is the pattern in `examples/nextjs`.

```ts
const result = await agent.run(input, { history: messagesFromClient });
// send result.newMessages back; the client appends them
```

## Observing a run

```ts
new Agent({
  provider,
  onEvent: (e) => {
    if (e.type === 'tool:start') console.log('calling', e.call.name, e.call.arguments);
    if (e.type === 'llm:response') console.log('model finished with', e.response.finishReason);
  },
});
```

Event types: `run:start`, `step:start`, `llm:request`, `llm:response`, `tool:start`, `tool:end`,
`tool:error`, `run:end`, `run:error`.

## Errors

| Error | When | Default handling |
| --- | --- | --- |
| `ProviderError` | HTTP error / bad body from the model API | thrown from `run()` |
| `MaxStepsExceededError` | the model kept calling tools past `maxSteps` (default 8) | thrown from `run()`; partial transcript is persisted |
| `ToolExecutionError`, `UnknownToolError` | a tool threw, or the model asked for a tool you don't have | **not thrown** — reported to the model as the tool result so it can recover |
| `AgentError` | base class of all of the above | — |

Cancellation: pass an `AbortSignal` via `run(input, { signal })`. It is forwarded to `fetch` and to
every tool's `ctx.signal`.

## Testing your own code

Use `MockProvider` to script model replies without network or keys:

```ts
import { Agent, MockProvider, toolCallMessage } from '@ajc-dev/app-agent';

const provider = new MockProvider([
  toolCallMessage({ name: 'get_weather', args: { city: 'Paris' } }), // 1st reply: call a tool
  'It is sunny in Paris.',                                            // 2nd reply: final text
]);
const result = await new Agent({ provider, tools: [getWeather] }).run('weather?');
```

See `tests/` for more.

## Documentation map

- **`docs/ARCHITECTURE.md`** — how the code works, file by file, written for someone learning TypeScript / agents.
- **`docs/NEXTJS.md`** — integrating into Next.js (App Router), both history patterns, runtime notes.
- **`examples/nextjs/`** — a runnable Next.js app.
- **`CHANGELOG.md`** — what this version contains and why.
- **`ROADMAP.md`** — what v0_02 should add.

## Project layout

```
v0_01/
├── src/
│   ├── index.ts                  public exports
│   ├── types.ts                  shared types (start here when reading)
│   ├── agent.ts                  the loop
│   ├── tool.ts                   defineTool, ToolRegistry
│   ├── memory.ts                 InMemoryMemory, NullMemory
│   ├── errors.ts                 typed errors
│   └── providers/
│       ├── openai-compatible.ts  fetch-based adapter
│       └── mock.ts               scripted fake for tests
├── tests/                        Vitest suites
├── examples/nextjs/              runnable demo app
├── docs/                         ARCHITECTURE.md, NEXTJS.md
├── CHANGELOG.md · ROADMAP.md
└── package.json · tsconfig*.json · vitest.config.ts · pnpm-workspace.yaml
```

## Requirements

Node 18+ (for global `fetch`), pnpm 10+ (settings live in `pnpm-workspace.yaml`). The library itself
has no runtime dependencies.
