# Using the agent in Next.js

The library is plain TypeScript with no framework coupling, so "Next.js support" mostly means
*putting the pieces in the right places*. A runnable version of everything below is in
`examples/nextjs/`. For Express, Hono, SvelteKit, Remix, or a plain HTML site, see
`INTEGRATION.md`.

**Contents**

1. [Adding the agent to an existing Next.js app (checklist)](#adding-the-agent-to-an-existing-nextjs-app)
2. [Where things go](#where-things-go)
3. [App Router: route handler](#minimal-route-handler-app-router)
4. [Pages Router: API route](#pages-router-api-route)
5. [Conversation history: two patterns](#two-ways-to-keep-conversation-history)
6. [Runtime: Node vs Edge](#runtime-node-vs-edge)
7. [Production checklist](#production-checklist)
8. [Deploying](#deploying)
9. [Sharing one Agent across requests](#sharing-one-agent-across-requests)
10. [Importing the library](#importing-the-library)

## Adding the agent to an existing Next.js app

You already have a Next.js project and want a chat/agent feature. Five steps:

1. **Install the library.** Until it is published on npm, either copy `v0_01/src/` into your project
   (e.g. `lib/app-agent/`) or add a file dependency: `pnpm add ../path/to/v0_01` (after running
   `pnpm build` there). The code is small and has no dependencies, so copying is a legitimate option.
2. **Add environment variables** to `.env.local` (never committed):
   ```
   OPENAI_API_KEY=sk-...
   OPENAI_BASE_URL=https://api.openai.com/v1   # or your provider / local server
   OPENAI_MODEL=gpt-4o-mini
   ```
   Do **not** prefix these with `NEXT_PUBLIC_` — that would ship them to the browser.
3. **Create a server-only module** `lib/agent.ts` that builds the provider, defines your tools, and
   exports one `Agent`. Copy `examples/nextjs/lib/agent.ts` and replace the demo tools with yours.
4. **Create the endpoint.** App Router: `app/api/agent/route.ts`. Pages Router: `pages/api/agent.ts`.
   Both are shown below.
5. **Call it from the UI.** Any client component can `fetch('/api/agent', { method: 'POST', body })`.
   `examples/nextjs/components/Chat.tsx` is a minimal, dependency-free starting point.

Then work through the [production checklist](#production-checklist) before shipping.

## Where things go

| Concern | Where | Why |
| --- | --- | --- |
| Provider, tools, `Agent` instance | a server-only module, e.g. `lib/agent.ts` | reads secrets from `process.env`; must never be imported by a `"use client"` file |
| HTTP endpoint | a route handler, e.g. `app/api/agent/route.ts` | the only thing the browser talks to |
| UI | a client component, e.g. `components/Chat.tsx` | calls the endpoint with `fetch`; holds UI state |

Rule of thumb: **the browser never sees the provider, the API key, or `execute` functions.**

## Minimal route handler (App Router)

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

## Pages Router (API route)

Older projects use `pages/api/`. The handler signature is Node-style (`req`, `res`) instead of the
web `Request`/`Response`, but the agent call is identical. API routes always run on the Node runtime.

```ts
// pages/api/agent.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { AgentError, type Message } from '@ajc-dev/app-agent';
import { agent } from '@/lib/agent';

type Data = { text: string; messages: Message[] } | { error: string };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Next.js has already parsed JSON into req.body (bodyParser is on by default).
  const { messages, input } = (req.body ?? {}) as { messages?: Message[]; input?: string };
  if (typeof input !== 'string' || !input.trim()) {
    return res.status(400).json({ error: 'input required' });
  }

  // There is no request.signal here; build one from the socket so a client
  // disconnect still cancels the run.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const result = await agent.run(input, { history: messages ?? [], signal: controller.signal });
    return res.status(200).json({ text: result.text, messages: result.newMessages });
  } catch (error) {
    const message = error instanceof AgentError ? error.message : 'Agent failed';
    return res.status(500).json({ error: message });
  }
}

// Optional: cap the request body (default is 1 MB). Long client-owned histories can grow.
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
```

Everything else in this guide (history patterns, production checklist, deployment) applies equally;
substitute `req.body` / `res.status().json()` where the App Router examples use `Request` /
`NextResponse`.

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

## Production checklist

The example is intentionally minimal. Before exposing the endpoint publicly, work through these.
Each item is a few lines; none require extra dependencies unless noted.

### 1. Require authentication

An unauthenticated agent endpoint is an open door to your model bill. Gate it with whatever your
app already uses (NextAuth/Auth.js, Clerk, a session cookie, an API key for machine clients):

```ts
// App Router, inside POST()
const session = await auth();                       // your auth library
if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
```

If you use server-owned history, derive the storage key from the session, not the request body:
`conversationId = \`${session.user.id}:${body.threadId}\``. Otherwise any user can read any thread.

### 2. Rate-limit per user

Each `run()` can be several model calls. Limit by user id (or IP for anonymous traffic). A minimal
in-process token bucket is fine for a single long-running server; on serverless use a shared store
(Upstash `@upstash/ratelimit`, Vercel KV, Redis).

```ts
const ok = await rateLimiter.limit(session.user.id);   // e.g. 20 requests / minute
if (!ok.success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
```

### 3. Validate and sanitise client input

The route trusts two things from the browser: `input` and (in the client-owned pattern) `messages`.
Treat both as hostile.

- **Cap `input` length** (e.g. 4,000 characters). Long inputs cost money and can be used to pad out
  the context window.
- **Reject `system` messages in client history.** Otherwise a user can inject their own system prompt
  and override yours. Also drop anything that is not a well-formed `user` / `assistant` / `tool`
  message, and cap the total count so the payload cannot grow without bound.

```ts
import type { Message, ToolCall } from '@ajc-dev/app-agent';

const MAX_HISTORY = 60;

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.arguments === 'string';
}

/** Keep only well-formed, non-system messages; drop everything else silently. */
export function sanitizeHistory(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  const out: Message[] = [];
  for (const item of raw.slice(-MAX_HISTORY)) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    switch (msg.role) {
      case 'user':
        if (typeof msg.content === 'string') out.push({ role: 'user', content: msg.content });
        break;
      case 'assistant': {
        if (msg.content !== null && typeof msg.content !== 'string') break;
        const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls.filter(isToolCall) : [];
        out.push({
          role: 'assistant',
          content: msg.content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        break;
      }
      case 'tool':
        if (
          typeof msg.toolCallId === 'string' &&
          typeof msg.name === 'string' &&
          typeof msg.content === 'string'
        ) {
          out.push({ role: 'tool', toolCallId: msg.toolCallId, name: msg.name, content: msg.content });
        }
        break;
      // 'system' and unknown roles are intentionally dropped
    }
  }
  return out;
}
```

A schema library (Zod, Valibot) makes this shorter and stricter; the hand-rolled version above
exists so the example stays dependency-free. Runtime validation of *tool arguments* is a separate
concern, covered in `ROADMAP.md` item 1.

- **Cap the request body.** App Router: check `request.headers.get('content-length')` or read with a
  limit. Pages Router: `export const config = { api: { bodyParser: { sizeLimit: '1mb' } } }`.

### 4. Harden your tools

Tools run on your server with your credentials. The model decides *when* to call them and *with what
arguments*, and the model can be steered by user text (prompt injection).

- Treat `args` as untrusted: clamp numbers, allow-list enum values, never interpolate into shell
  commands or SQL.
- Give tools the **least privilege** they need. A `send_email` tool should be able to email the
  current user, not arbitrary addresses.
- Pass the user's identity into tools via closure, not via model-provided arguments:
  ```ts
  function buildAgent(userId: string) {
    const getMyOrders = defineTool({ /* ... */ execute: () => db.orders.where({ userId }) });
    return new Agent({ provider, tools: [getMyOrders] });
  }
  ```
  (Building per request is cheap — `Agent` is a thin object. Share the `provider`.)
- Honour `ctx.signal` in long-running tools so cancelled requests stop doing work.
- Keep tool results small (truncate large API responses) so one tool cannot flood the context.

### 5. Bound cost and time

- `maxSteps` (default 8): lower it for simple assistants (3–4). Each step is a model call.
- `maxTokens` on the agent/provider to cap reply size.
- `maxDuration` on the route (see [Deploying](#deploying)).
- Log `result.usage` per user so you can spot abuse. The `run:end` event carries it.

### 6. Return the right errors

Map library errors to HTTP status codes and avoid leaking provider details to the browser:

| Error | Status | Client message |
| --- | --- | --- |
| validation failure | 400 | what was wrong |
| unauthenticated | 401 | — |
| rate limited | 429 | retry later |
| `MaxStepsExceededError` | 500 (or 200 with partial text) | "I couldn't finish — try rephrasing" |
| `ProviderError` with `status` 429/5xx | 503 | "Model is busy, try again" |
| `ProviderError` with `status` 401 | 500 | generic — this is *your* key misconfigured; log it |
| aborted (`AbortError`) | — | client already left; just return |

Log the full error server-side (`console.error` is fine on Vercel; it reaches the function logs).

### 7. CORS (only if the UI is on a different origin)

Same-origin Next.js apps need nothing. If a separate frontend (or a widget embedded on other sites)
calls the endpoint, add explicit CORS headers and handle the preflight:

```ts
const ALLOWED = new Set(['https://www.example.com']);

function cors(origin: string | null) {
  const allow = origin && ALLOWED.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    Vary: 'Origin',
  };
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: cors(request.headers.get('origin')) });
}
// and spread cors(...) into the headers of every POST response
```

Never use `*` on an authenticated endpoint.

### 8. Observability

Wire `onEvent` to your logger. At minimum log `tool:start` (name + args), `tool:error`, `run:end`
(steps, usage, duration), and `run:error`. Include a request id so one conversation turn can be
traced across model calls. Be careful logging `llm:request` in production — it contains the whole
transcript, which may be personal data.

### 9. Secrets

- Only read keys in server modules. Never with a `NEXT_PUBLIC_` prefix.
- On Vercel/Netlify set them in the dashboard, not in committed files.
- Prefer a provider key scoped to this app with a spending limit.

## Deploying

### Vercel

1. Push the repo; import the project. Framework preset: Next.js.
2. Settings → Environment Variables: add `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` for
   Production (and Preview if you want preview deployments to work).
3. In the route file set a duration that covers a multi-step run:
   ```ts
   export const maxDuration = 60; // seconds; Hobby caps at 60, Pro/Enterprise allow more
   ```
4. If you use server-owned history, provision Vercel KV / Upstash and implement `Memory` against it;
   `InMemoryMemory` will appear to work on a warm function and then silently forget.

### Self-hosted Node (Docker, VM, Railway, Fly, Render)

`next build && next start` behind a reverse proxy. Because it is one long-lived process,
`InMemoryMemory` *does* persist until restart — still use a real store if you run more than one
replica or care about restarts. Set proxy timeouts (nginx `proxy_read_timeout`, etc.) above your
longest expected run, otherwise the proxy will cut the response at 30–60 s.

### Netlify / Cloudflare

Both run route handlers as serverless/edge functions with their own time limits (Netlify ~10 s on
the free tier for synchronous functions; Cloudflare Workers have CPU-time rather than wall-clock
limits, which suits `fetch`-bound work well). Use the Edge runtime on Cloudflare. Check the current
limits for your plan before relying on long tool chains; streaming (roadmap item 2) relaxes most of
these constraints.

### Local models in production

Point `OPENAI_BASE_URL` at your Ollama / vLLM / LM Studio server. Make sure it is reachable from
where the Next.js server runs (not just from your laptop) and that it is not exposed to the public
internet without auth.

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
