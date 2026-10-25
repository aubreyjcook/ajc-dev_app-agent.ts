# Roadmap — toward v0_02

Ordered by value to someone embedding the agent in a real app. Each item notes the files it would
touch and the concept it teaches, since the versions double as a learning path.

## 1. Runtime validation of tool arguments
**Why:** today `execute` receives unvalidated JSON cast to `TArgs`. A wrong-shaped payload is a
runtime surprise instead of a clear tool error the model can fix.
**Shape:** optional `validate?: (raw: unknown) => TArgs` on `ToolDefinition`; a tiny built-in
checker for the JSON Schema subset we actually use (`type`, `properties`, `required`, `enum`), plus a
documented adapter pattern for Zod / Valibot users without taking a dependency.
**Touches:** `types.ts`, `tool.ts`, tests. **Teaches:** trust boundaries, schema validation.

## 2. Streaming
**Why:** a 10-second wait with no feedback is the #1 UX complaint for agent features.
**Shape:** `LLMProvider.stream?()` returning an async iterable of deltas; `Agent.stream()` yielding
`AgentEvent`s plus `text:delta` events; `fromSseStream()` helper for the OpenAI SSE format; Next.js
route handler returning a `ReadableStream`; `Chat.tsx` rendering tokens as they arrive.
**Touches:** `types.ts`, `agent.ts`, `providers/openai-compatible.ts`, example. **Teaches:** async
iterators, SSE, `ReadableStream`, backpressure.

## 3. Concurrent tool execution
**Why:** when the model asks for three independent lookups, running them in parallel is 3× faster.
**Shape:** `AgentOptions.toolConcurrency: 'sequential' | 'parallel'` (default stays sequential for
predictable logs in learning mode); results are appended in call order regardless of completion order.
**Touches:** `agent.ts`. **Teaches:** `Promise.all`, preserving order with concurrency.

## 4. Retries and timeouts in the provider
**Why:** real APIs return 429/5xx; a production agent should not fail on the first one.
**Shape:** `OpenAICompatibleOptions.retry: { attempts, backoffMs }` and `timeoutMs` using
`AbortSignal.timeout()` combined with the caller's signal. Retry only on idempotent failures
(429, 5xx, network). **Teaches:** exponential backoff, combining abort signals.

## 5. Anthropic Messages provider
**Why:** second provider proves the `LLMProvider` abstraction is real, and Anthropic's format differs
enough (system prompt as a top-level field, `tool_use` / `tool_result` content blocks) to be instructive.
**Touches:** new `providers/anthropic.ts`, tests. **Teaches:** adapter pattern under real pressure.

## 6. Structured output / `finish` tool
**Why:** apps often want a typed object back, not prose.
**Shape:** `agent.run(input, { output: schema })` that registers a synthetic `final_answer` tool and
returns its validated arguments. Depends on item 1.

## 7. Memory helpers
- `windowed(memory, { maxMessages })` wrapper that trims old turns before each request.
- Reference `Memory` implementations for Vercel KV / Upstash Redis in `examples/`.
**Teaches:** context-window management, decorator pattern.

## 8. Tool result size limits
Truncate or summarise tool outputs over N characters with an explicit marker, so a chatty tool cannot
blow the context window. Small change in `tool.ts` / `agent.ts`, big reliability win.

## 9. Publishing
`CHANGELOG`-driven release, `npm publish --access public`, `exports` map already in place. Add
`CONTRIBUTING.md` and CI (typecheck + test + build) at the repo root.

## Explicitly deferred

- Multi-agent orchestration, planners, memory summarisation with a model — out of scope for a
  "bare-bones" library until the single-agent loop is solid.
- A React hook package (`useAgent`) — nice, but the fetch call in `Chat.tsx` is 15 lines; wait until
  streaming settles the protocol.
