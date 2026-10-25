# Using the agent in Next.js

The library is plain TypeScript with no framework coupling, so "Next.js support" mostly means
*putting the pieces in the right places*. A runnable version of everything below is in
`examples/nextjs/`.

## Where things go

| Concern | Where | Why |
| --- | --- | --- |
| Provider, tools, `Agent` instance | a server-only module, e.g. `lib/agent.ts` | reads secrets from `process.env`; must never be imported by a `"use client"` file |
| HTTP endpoint | a route handler, e.g. `app/api/agent/route.ts` | the only thing the browser talks to |
| UI | a client component, e.g. `components/Chat.tsx` | calls the endpoint with `fetch`; holds UI state |

Rule of thumb: **the browser never sees the provider, the API key, or `execute` functions.**

## Minimal route handler

```ts
// app/api/agent/route.ts
import { NextResponse } from 'next/server';
import { AgentError, type Message } from '@ajc-dev/app-agent';
import { agent } from '@/lib/agent';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const { messages, input } = (await request.json()) as { messages?: Message[]; input?: string };
  if (typeof input !== 'string' || !input.trim()) {
    return NextResponse.json({ error: 'input required' }, { status: 400 });
  }
  try {
    const result = await agent.run(input, { history: messages ?? [], signal: request.signal });
    return NextResponse.json({ text: result.text, messages: result.newMessages });
  } catch (error) {
    const message = error instanceof AgentError ? error.message : 'Agent failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

`request.signal` aborts the agent (and the in-flight model call) if the user navigates away.

## Two ways to keep conversation history

### A. Client owns it (stateless server) — used by the example

The browser keeps `Message[]` in React state, sends it with every request, and appends
`result.newMessages` from the response. Configure the agent with `memory: new NullMemory()`.

Pros: no server state, scales horizontally, trivially works on serverless/edge.
Cons: payload grows with the conversation; the client can tamper with history.

### B. Server owns it

Client sends `{ conversationId, input }`. The agent loads and saves via `Memory`.

```ts
const result = await agent.run(input, { conversationId, signal: request.signal });
return NextResponse.json({ text: result.text });
```

`InMemoryMemory` (the default) is fine for `next dev` but **not** for production: serverless functions
are recycled and multiple instances do not share memory. Implement the three-method `Memory`
interface against Redis, Postgres, KV, etc.:

```ts
import type { Memory, Message } from '@ajc-dev/app-agent';

export class KvMemory implements Memory {
  async load(id: string): Promise<Message[]> { /* read */ }
  async append(id: string, msgs: Message[]) { /* append */ }
  async clear(id: string) { /* delete */ }
}
```

Tip: pair `conversationId` with the authenticated user id so users cannot read each other's threads.

## Runtime: Node vs Edge

The library only uses `fetch`, `JSON`, and `AbortSignal`, so it runs on both. Choose per route:

- `export const runtime = 'nodejs'` (default) — pick this if any tool touches a database, the file
  system, or Node-only packages. Longer timeouts on most hosts.
- `export const runtime = 'edge'` — lower latency cold starts; tools must also be edge-safe.

Agent runs can take tens of seconds when several tool round-trips are involved. On Vercel, set
`export const maxDuration = 60;` (or higher on paid plans) in the route file.

## Sharing one `Agent` across requests

Creating the agent at module scope (as `lib/agent.ts` does) is safe as long as it holds no
per-request state. With `NullMemory` or a DB-backed `Memory` it holds none. With `InMemoryMemory` it
holds all conversations for that process — acceptable in dev only.

## Importing the library

Until the package is published, `examples/nextjs/package.json` depends on it with
`"@ajc-dev/app-agent": "link:../.."`. That links to the built `dist/`, so run `pnpm build` in `v0_01`
first and again after changing library source. In your own project you would `pnpm add` the published
package, or copy `src/` in directly — it is small enough.

## Things not yet covered (see `ROADMAP.md`)

- Streaming tokens to the UI (today the UI waits for the whole run).
- Validating tool arguments at runtime.
- Returning intermediate tool results to the browser *while* the run is in progress (you can get
  them after the fact from `newMessages`, as the example does).
