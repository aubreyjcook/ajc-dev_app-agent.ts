# ajc-dev_app-agent.ts

Agent for attaching to sites and applications.

A bare-bones, zero-dependency TypeScript agent loop (model → tools → model) that can be wired into a
pre-existing website or web app, with first-class consideration for Next.js. Written to be *read*:
every version ships with documentation aimed at someone learning TypeScript and how agents work.

## Versions

Versions live in `v0_0x/` directories. Each is self-contained with its own `README.md`, `CHANGELOG.md`
and `ROADMAP.md`.

| Version | Summary |
| --- | --- |
| [`v0_01/`](./v0_01/README.md) | Initial skeleton: `Agent` loop with tool calling, `LLMProvider` interface, OpenAI-compatible `fetch` adapter, mock provider, in-memory conversation store, Vitest suite, Next.js example app. |

## Quick look

```bash
cd v0_01
pnpm install && pnpm test && pnpm build
```

Then read [`v0_01/docs/ARCHITECTURE.md`](./v0_01/docs/ARCHITECTURE.md).

## For agents working on this repo

See `agent-instructions.md`.
