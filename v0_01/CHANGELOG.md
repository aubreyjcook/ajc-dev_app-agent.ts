# Changelog — v0_01

**First version. Everything is new.** This entry explains *what* exists and *why it is shaped this
way*, for someone using the version to learn.

## Added

### Core agent loop (`src/agent.ts`)
- `Agent` class and `createAgent()` factory.
- `run(input, { conversationId?, history?, signal? })` → `AgentResult` with `text`, `newMessages`,
  `messages`, `steps`, `finishReason`, `usage`.
- Tool-calling loop: model → tools → model, repeated until the model replies with text.
- `maxSteps` guard (default 8) throwing `MaxStepsExceededError`; partial transcript is persisted
  first so stored history stays well-formed.
- Tool failures (unknown tool, bad JSON args, thrown error) are reported **to the model** as the tool
  result instead of aborting the run.
- System prompt injected per request rather than stored in history.
- Cooperative cancellation via `AbortSignal`, forwarded to the provider and tools.
- Lifecycle events via `onEvent`: `run:start`, `step:start`, `llm:request`, `llm:response`,
  `tool:start`, `tool:end`, `tool:error`, `run:end`, `run:error`. Handler exceptions are swallowed.

### Tools (`src/tool.ts`)
- `defineTool()` typed helper with tool-name validation (`[a-zA-Z0-9_-]{1,64}`).
- `ToolRegistry` with duplicate detection, `specs()`, and `run()`.
- `parseToolArguments()` (empty string → `{}`) and `serializeToolResult()` helpers.

### Providers
- `LLMProvider` interface — single `complete()` method (`src/types.ts`).
- `OpenAICompatibleProvider` (`src/providers/openai-compatible.ts`): `fetch`-based, no SDK. Options:
  `model`, `apiKey` (optional for local servers), `baseUrl`, `headers`, injectable `fetch`. Maps
  messages/tools to and from the OpenAI wire format; normalises `finish_reason`; surfaces HTTP
  errors as `ProviderError { status, body }`; passes `AbortError` through unchanged.
- `MockProvider` + `toolCallMessage()` (`src/providers/mock.ts`) for scripted, offline runs.

### Memory (`src/memory.ts`)
- `Memory` interface (`load` / `append` / `clear`, keyed by conversation id).
- `InMemoryMemory` (default) and `NullMemory` (client-owned history).

### Errors (`src/errors.ts`)
- `AgentError` base; `ProviderError`, `ToolExecutionError`, `UnknownToolError`,
  `MaxStepsExceededError`; `describeError()` helper.

### Tooling
- TypeScript 5 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM / `NodeNext`.
- Vitest suite: 31 tests covering the loop, tool registry, and provider wire mapping — all offline.
- `pnpm build` emits `dist/` with `.js`, `.d.ts`, and source maps.
- pnpm 10+/11 settings in `pnpm-workspace.yaml` (`allowBuilds` for esbuild).

### Example (`examples/nextjs/`)
- Next.js 15 App Router app: `lib/agent.ts` (provider + two demo tools), `app/api/agent/route.ts`
  (POST handler, client-owned history), `components/Chat.tsx` (plain React chat UI). Verified with
  `next build` and an end-to-end request against a fake OpenAI-compatible server.

### Documentation
- `README.md` (usage), `docs/ARCHITECTURE.md` (code walkthrough for learners),
  `docs/NEXTJS.md` (integration guide), this changelog, and `ROADMAP.md`.

## Known limitations

- Tool arguments are parsed but **not validated** against the schema; `execute` must treat them as
  untrusted.
- No streaming — `run()` resolves only when the whole loop completes.
- Tools run sequentially within a step.
- Only the OpenAI-compatible wire format is implemented (covers most vendors, but not Anthropic's
  native API or Google's).
- `InMemoryMemory` is process-local; not suitable for serverless production.

## Fixed during development

- `Agent.withSystemPrompt()` returned the live `transcript` array when no system prompt was set, so
  providers and `onEvent` listeners saw later mutations. Now always returns a copy. Caught by the
  `MockProvider`-based tests — a concrete reason to test with a mock before touching a real API.
