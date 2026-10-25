# Architecture — how the code works

This document is for someone who knows programming fundamentals and wants to understand *how* an
agent works by reading this one. It walks the code in the order you should read it. The source files
carry detailed inline comments; this is the map.

## The one idea

Large language models are a function: `messages in → message out`. They cannot run code, fetch URLs,
or remember anything between calls. An **agent** is a small program wrapped around that function which
gives it those abilities:

```
            ┌────────────────────────────────────────────────┐
            │                   Agent.run()                  │
            │                                                │
 user text ─┼─► transcript ─► provider.complete() ─► reply   │
            │        ▲                                │      │
            │        │          has tool calls?       │      │
            │        │          ┌─────── yes ◄────────┘      │
            │        │          ▼                     no     │
            │        └── run tools, append results    │      │
            │                                         ▼      │
            └────────────────────────────────── return text ─┘
```

That loop is `Agent.run()` in `src/agent.ts`. Everything else exists to feed it or observe it.

## Reading order

### 1. `src/types.ts` — the vocabulary

Four message roles make up a transcript:

| role | who writes it | contains |
| --- | --- | --- |
| `system` | you | standing instructions ("You are a helpful assistant") |
| `user` | the human | their message |
| `assistant` | the model | text **or** a list of `toolCalls` |
| `tool` | the agent | result of one tool call, tagged with its `toolCallId` |

A `ToolCall` is the model saying "run `roll_dice` with `{"count":2}`". Note `arguments` is the **raw
JSON string** — models sometimes produce invalid JSON, so parsing is deferred to where the error can be
handled.

A `ToolDefinition` is a name, a description, a JSON Schema for the arguments, and an `execute`
function. The first three are sent to the model (as a `ToolSpec`); `execute` never leaves the server.

`LLMProvider` is the contract for a model backend: one method, `complete(request) → response`. The
agent depends only on this interface, which is why you can swap OpenAI for Ollama or for a test mock
without touching the loop. This is the **dependency inversion** principle in action.

`Memory` is the contract for conversation storage: `load`, `append`, `clear`, keyed by a conversation id.

`AgentEvent` is a discriminated union of everything the agent can tell you about while it runs.

> **TypeScript note.** Many of these are *discriminated unions* — a `type` or `role` string field lets
> `switch (message.role)` narrow the type automatically. You will see this pattern everywhere.

### 2. `src/agent.ts` — the loop

`run()` does, in order:

1. **Assemble the transcript.** Load stored history (`memory.load`), append any caller-supplied
   `history`, then the new `user` message. The system prompt is *not* stored; it is prepended at
   request time by `withSystemPrompt()` so you can change it later without rewriting history.
2. **Guard.** If `steps >= maxSteps`, persist what we have and throw `MaxStepsExceededError`. This is
   the only thing standing between you and an infinite loop if a model keeps calling tools.
3. **Call the model.** Build a `ProviderRequest` (messages + tool specs + model params) and `await
   provider.complete()`. Emit `llm:request` / `llm:response` events around it.
4. **Branch on the reply.**
   - No tool calls → we are done. Persist `newMessages`, build the `AgentResult`, return.
   - Tool calls → for each one, `tools.run(call)`, wrap the string result in a `tool` message, append
     it. **Errors are caught and sent to the model as text** (`"Error: Unknown tool …"`) rather than
     thrown. This is deliberate: a model that is told what went wrong can usually recover; a crashed
     request cannot.
5. **Loop** back to step 2. The model now sees the tool results and either answers or asks for more.

Things worth noticing in the code:

- `transcript` grows during the run; `withSystemPrompt()` always returns a **copy** so the array handed
  to the provider (and to your `onEvent` listener) is a stable snapshot. The test suite caught this
  aliasing bug during development — a good example of why tests on a mock are worth having.
- `emit()` swallows exceptions from your event handler. Observers must never be able to break the run.
- `signal?.throwIfAborted()` is checked at the top of every step and before every tool, and the signal
  is forwarded to `fetch` and to tools, so cancellation is cooperative end to end.

### 3. `src/tool.ts` — tools

- `defineTool()` is an identity function. It exists so TypeScript can infer the argument type for
  `execute` from the generic, and so tools are easy to find with grep. It also validates the name
  against the `[a-zA-Z0-9_-]{1,64}` rule every major API enforces, failing at startup instead of at
  request time.
- `ToolRegistry` is a `Map<string, ToolDefinition>` with `specs()` (model-facing list) and `run()`
  (lookup → `parseToolArguments` → `execute` → `serializeToolResult`). It **throws** on failure; the
  agent decides what to do with the failure. Keeping policy in one place is the point.
- `parseToolArguments` treats `""` as `{}` because some models emit an empty string for zero-argument
  tools.

> **v0_01 limitation:** arguments are parsed, not validated. `execute` receives whatever JSON the model
> produced, cast to your `TArgs`. Treat it as untrusted (the example's `roll_dice` clamps its inputs).
> Runtime validation is first on the roadmap.

### 4. `src/providers/openai-compatible.ts` — talking to a real model

Three pure-ish functions and one class:

- `toWireRequest()` — our `ProviderRequest` → the OpenAI JSON body. Mostly a field-by-field rename
  (`toolCalls` → `tool_calls`, `maxTokens` → `max_tokens`, tool specs wrapped in
  `{ type: 'function', function: … }`).
- `fromWireResponse()` — the reverse. It also normalises `finish_reason`: some servers say `"stop"` even
  when tool calls are present, so we trust the presence of `tool_calls` over the label.
- `complete()` — `fetch` POST to `${baseUrl}/chat/completions`, with the Bearer header only if an API
  key was given (local servers need none). Non-2xx → `ProviderError` carrying `status` and the parsed
  body. Network failure → `ProviderError` with `cause`. An `AbortError` is re-thrown untouched so
  callers can tell "cancelled" from "failed".

`fetch` is injectable (`options.fetch`) which is how the tests exercise this file with no network.

Because the whole file uses only `fetch`, it works on Node 18+, browsers, Cloudflare Workers, Vercel
Edge, Deno and Bun.

### 5. `src/providers/mock.ts` — a model you control

`MockProvider` takes a list of scripted replies and returns them in order, recording every request in
`.requests`. Replies can be a string (final text), an `AssistantMessage` (full control), a
`ProviderResponse`, or a function of the request (handy for assertions mid-run). `toolCallMessage()`
builds the tool-calling variant tersely.

If you want to *see* the loop work, put a breakpoint in `Agent.run()` and run `tests/agent.test.ts`.

### 6. `src/memory.ts` — history

`InMemoryMemory` is a `Map<string, Message[]>`. `load` returns a copy (defensive — callers can't
corrupt our state). `NullMemory` stores nothing, for the client-owned-history pattern.

### 7. `src/errors.ts` — errors you can `instanceof`

All extend `AgentError`. Each sets `this.name` so logs read well, and carries structured fields
(`status`, `body`, `toolName`, `steps`) so calling code can branch without parsing messages.

## Design decisions (and why)

| Decision | Reason |
| --- | --- |
| Zero runtime dependencies | Nothing to audit, nothing to conflict with the host app's versions, trivially portable across runtimes. |
| Hand-written provider adapter instead of a vendor SDK | The OpenAI wire format is ~60 lines to map and covers most of the ecosystem; an SDK would hide exactly the part a learner wants to see. |
| Tools fail *soft* (reported to model) | Resilience. The alternative — aborting the run — turns every flaky API into a user-facing error. |
| `maxSteps` is mandatory (default 8) | Infinite tool loops are the most common agent failure mode. |
| System prompt injected per request, not stored | Prompts change often; stored history should not have to be rewritten. |
| Sequential tool execution | Simpler to read and to log in v0_01. Concurrency is a one-line change (`Promise.all`) planned for v0_02. |
| ESM only, `NodeNext` resolution | Modern Node and all bundlers consume it; it is also why `src/` imports end in `.js`. |
| `exactOptionalPropertyTypes` on | Forces explicit `| undefined` on optional fields, which surfaces real bugs when assembling request objects. |

## Glossary

- **Agent loop / ReAct loop** — the call-model → act → observe cycle described above.
- **Tool / function calling** — the model emitting structured requests to run named functions.
- **Provider** — a model backend behind the `LLMProvider` interface.
- **Step** — one call to the provider. A tool round-trip costs one step.
- **Transcript** — the ordered list of messages the model sees.
