# Hooking the agent into any site or app

`NEXTJS.md` covers Next.js in depth. This guide covers everything else: a plain HTML site, an
Express/Fastify/Hono backend, SvelteKit, Remix, Nuxt, a CLI, or a background job. The library has
no framework coupling, so the pattern is always the same three parts.

## The pattern

```
 ┌──────────────┐    POST { messages | conversationId, input }    ┌──────────────────────┐
 │  any client  │ ───────────────────────────────────────────────► │  one server endpoint │
 │ (browser,    │                                                  │   agent.run(...)     │ ──► model API
 │  mobile, CLI)│ ◄─────────────────────────────────────────────── │   + your tools       │
 └──────────────┘        { text, messages }                        └──────────────────────┘
```

1. **A server module** that creates the provider, defines tools, and exports one `Agent`. This is
   where the API key lives. (Same file in every framework — see `examples/nextjs/lib/agent.ts`.)
2. **One HTTP endpoint** that reads `input` (and either client history or a `conversationId`),
   calls `agent.run()`, and returns `result.text` plus `result.newMessages`.
3. **A client** that POSTs to that endpoint and renders the reply. It never talks to the model
   directly.

Decide up front who owns the conversation history — the client (sends the transcript each time,
server uses `NullMemory`) or the server (client sends a `conversationId`, server uses a `Memory`).
`NEXTJS.md` → "Two ways to keep conversation history" discusses the trade-offs; they are identical
for every host below.

The request/response contract used throughout:

```ts
// request
{ "input": string, "messages"?: Message[] }            // client-owned history
{ "input": string, "conversationId": string }          // server-owned history
// response
{ "text": string, "messages": Message[] }              // messages = new ones from this turn
{ "error": string }                                    // on failure, with a 4xx/5xx status
```

## The shared server module

Every example below imports this. Put it wherever your server code lives.

```ts
// agent.ts (server only)
import { Agent, NullMemory, OpenAICompatibleProvider, defineTool } from '@ajc-dev/app-agent';

const provider = new OpenAICompatibleProvider({
  model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
});

const getCurrentTime = defineTool<{ timeZone?: string }, string>({
  name: 'get_current_time',
  description: 'Current date and time, optionally in an IANA time zone.',
  parameters: { type: 'object', properties: { timeZone: { type: 'string' } } },
  execute: ({ timeZone }) =>
    new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: timeZone ?? 'UTC' })
      .format(new Date()),
});

export const agent = new Agent({
  provider,
  tools: [getCurrentTime],
  systemPrompt: 'You are a concise assistant embedded in a website.',
  memory: new NullMemory(),   // client-owned history; swap for your own Memory to keep it server-side
  maxSteps: 6,
});
```

Until the package is on npm: copy `v0_01/src/` into your project (it is ~600 lines, zero
dependencies) or `pnpm add ../path/to/v0_01` after `pnpm build` there.

---

## Express

```ts
// server.ts
import express from 'express';
import { AgentError } from '@ajc-dev/app-agent';
import { agent } from './agent.js';

const app = express();
app.use(express.json({ limit: '1mb' }));          // parses JSON bodies, caps size
app.use(express.static('public'));                // serves the HTML/JS widget below (optional)

app.post('/api/agent', async (req, res) => {
  const { input, messages } = req.body ?? {};
  if (typeof input !== 'string' || !input.trim()) {
    return res.status(400).json({ error: 'input required' });
  }

  // Cancel the run if the client disconnects.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const result = await agent.run(input, {
      history: Array.isArray(messages) ? messages : [],
      signal: controller.signal,
    });
    res.json({ text: result.text, messages: result.newMessages });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return;  // client left
    console.error(error);
    res.status(500).json({ error: error instanceof AgentError ? error.message : 'Agent failed' });
  }
});

app.listen(3000, () => console.log('http://localhost:3000'));
```

Run with `node --env-file=.env server.js` (Node 20+) or load `.env` however you already do.
Fastify is the same shape: `fastify.post('/api/agent', async (request, reply) => { ... })`, with the
body already parsed and `request.raw.on('close', ...)` for the abort hook.

## Hono (Node, Bun, Deno, Cloudflare Workers, Vercel Edge)

Hono uses web-standard `Request`/`Response`, so the handler is nearly identical to a Next.js route
handler and runs unchanged on every runtime Hono supports.

```ts
import { Hono } from 'hono';
import { AgentError } from '@ajc-dev/app-agent';
import { agent } from './agent.js';

const app = new Hono();

app.post('/api/agent', async (c) => {
  const { input, messages } = await c.req.json().catch(() => ({}));
  if (typeof input !== 'string' || !input.trim()) return c.json({ error: 'input required' }, 400);

  try {
    const result = await agent.run(input, {
      history: Array.isArray(messages) ? messages : [],
      signal: c.req.raw.signal,
    });
    return c.json({ text: result.text, messages: result.newMessages });
  } catch (error) {
    console.error(error);
    return c.json({ error: error instanceof AgentError ? error.message : 'Agent failed' }, 500);
  }
});

export default app;
```

On Cloudflare Workers, read secrets from `c.env` instead of `process.env` and construct the
provider inside the handler (or lazily once).

## SvelteKit

```ts
// src/routes/api/agent/+server.ts
import { json, type RequestHandler } from '@sveltejs/kit';
import { AgentError } from '@ajc-dev/app-agent';
import { agent } from '$lib/server/agent';   // $lib/server/* is guaranteed never to reach the client

export const POST: RequestHandler = async ({ request }) => {
  const { input, messages } = await request.json().catch(() => ({}));
  if (typeof input !== 'string' || !input.trim()) return json({ error: 'input required' }, { status: 400 });

  try {
    const result = await agent.run(input, {
      history: Array.isArray(messages) ? messages : [],
      signal: request.signal,
    });
    return json({ text: result.text, messages: result.newMessages });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof AgentError ? error.message : 'Agent failed' }, { status: 500 });
  }
};
```

Use `$env/static/private` or `$env/dynamic/private` for the key inside `$lib/server/agent.ts`.

## Remix / React Router (framework mode)

```ts
// app/routes/api.agent.ts
import type { ActionFunctionArgs } from 'react-router';   // or '@remix-run/node'
import { AgentError } from '@ajc-dev/app-agent';
import { agent } from '~/lib/agent.server';               // *.server.ts never ships to the browser

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const { input, messages } = await request.json().catch(() => ({}));
  if (typeof input !== 'string' || !input.trim()) return Response.json({ error: 'input required' }, { status: 400 });

  try {
    const result = await agent.run(input, {
      history: Array.isArray(messages) ? messages : [],
      signal: request.signal,
    });
    return Response.json({ text: result.text, messages: result.newMessages });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error instanceof AgentError ? error.message : 'Agent failed' }, { status: 500 });
  }
}
```

## Nuxt (Nitro)

```ts
// server/api/agent.post.ts
import { AgentError } from '@ajc-dev/app-agent';
import { agent } from '../utils/agent';   // server/utils is server-only and auto-imported

export default defineEventHandler(async (event) => {
  const { input, messages } = await readBody(event).catch(() => ({}));
  if (typeof input !== 'string' || !input.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'input required' });
  }

  const controller = new AbortController();
  event.node.req.on('close', () => controller.abort());

  try {
    const result = await agent.run(input, {
      history: Array.isArray(messages) ? messages : [],
      signal: controller.signal,
    });
    return { text: result.text, messages: result.newMessages };
  } catch (error) {
    console.error(error);
    throw createError({ statusCode: 500, statusMessage: error instanceof AgentError ? error.message : 'Agent failed' });
  }
});
```

Use `useRuntimeConfig()` (private keys, not `public`) for the API key.

---

## A plain HTML site (no framework)

A static site cannot hold the API key, so it still needs *some* server endpoint — one of the ones
above, or a serverless function on Vercel/Netlify/Cloudflare. The front end is then a few dozen
lines of vanilla JS. This drops into any page:

```html
<!-- public/index.html -->
<div id="chat">
  <ol id="log"></ol>
  <form id="form">
    <input id="input" placeholder="Ask something…" autocomplete="off" />
    <button>Send</button>
  </form>
</div>

<script type="module">
  const ENDPOINT = '/api/agent';           // or an absolute URL if the API is elsewhere (needs CORS)
  const log = document.getElementById('log');
  const form = document.getElementById('form');
  const input = document.getElementById('input');

  let messages = [];                       // the browser owns the transcript

  function render(message) {
    const li = document.createElement('li');
    if (message.role === 'tool') {
      li.style.opacity = 0.6;
      li.textContent = `↳ ${message.name}: ${message.content}`;
    } else if (message.role === 'assistant' && !message.content) {
      li.style.opacity = 0.6;
      li.textContent = (message.toolCalls ?? []).map((c) => `${c.name}(${c.arguments})`).join(', ');
    } else {
      li.textContent = `${message.role === 'user' ? 'You' : 'Agent'}: ${message.content}`;
    }
    log.appendChild(li);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.disabled = true;

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: text, messages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      messages = messages.concat(data.messages);
      data.messages.forEach(render);
    } catch (err) {
      const li = document.createElement('li');
      li.style.color = 'crimson';
      li.textContent = `Error: ${err.message}`;
      log.appendChild(li);
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
</script>
```

To embed the same widget on *other people's* sites (a support bubble, say), host this script on
your domain, set `ENDPOINT` to an absolute URL, and configure CORS on the endpoint — see
`NEXTJS.md` → "Production checklist → CORS". Rate-limit by IP since there is no user session.

## Outside HTTP: CLI, cron, queue worker

No endpoint needed; call the agent directly. `InMemoryMemory` (the default) is fine because the
process owns the whole conversation.

```ts
// cli.ts — run with: node --env-file=.env cli.js
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Agent, OpenAICompatibleProvider } from '@ajc-dev/app-agent';

const agent = new Agent({
  provider: new OpenAICompatibleProvider({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY }),
  onEvent: (e) => e.type === 'tool:start' && console.log(`  [tool] ${e.call.name}`),
});

const rl = readline.createInterface({ input: stdin, output: stdout });
const conversationId = 'cli';
for (;;) {
  const line = await rl.question('> ');
  if (!line.trim()) continue;
  const { text } = await agent.run(line, { conversationId });
  console.log(text);
}
```

For a one-shot job (summarise a record, classify a ticket) just `await agent.run(prompt)` and use
`result.text`; omit `conversationId` and nothing is remembered.

---

## Checklist for any host

The production concerns are the same everywhere; `NEXTJS.md` → "Production checklist" covers each
in detail. In short:

- [ ] API key read only on the server; never bundled or sent to the browser.
- [ ] Endpoint requires authentication (or is rate-limited by IP if anonymous is intended).
- [ ] `input` length capped; client-supplied `messages` sanitised (no `system` role, bounded count).
- [ ] Request body size capped.
- [ ] Tools treat arguments as untrusted and have least privilege; user identity comes from the
      session, not from model arguments.
- [ ] `maxSteps` / `maxTokens` set deliberately; host/proxy timeouts cover the longest expected run.
- [ ] Client disconnect aborts the run (`request.signal` or `req.on('close')`).
- [ ] Errors mapped to sensible status codes; provider details logged, not returned.
- [ ] `onEvent` wired to logging with a request id.
- [ ] If history is server-owned: a real `Memory` implementation, keyed by user + thread.
