# Next.js example

The smallest useful integration of `@ajc-dev/app-agent` into a Next.js (App Router) project:
one route handler on the server, one client component in the browser.

```
examples/nextjs/
├── app/
│   ├── api/agent/route.ts   ← POST handler: runs the agent          (server)
│   ├── layout.tsx
│   └── page.tsx             ← mounts <Chat />
├── components/Chat.tsx      ← chat UI, owns the transcript          (browser)
└── lib/agent.ts             ← provider + tools + Agent instance     (server)
```

## Run it

```bash
# 1. Build the library (the example links to ../../dist)
cd v0_01
pnpm install
pnpm build

# 2. Install and start the example
cd examples/nextjs
pnpm install
cp .env.example .env.local      # then fill in OPENAI_API_KEY (or point at Ollama etc.)
pnpm dev
```

Open http://localhost:3000 and try "what time is it in Tokyo?" or "roll 3 dice".

Tool calls and results are shown greyed-out in the transcript so you can watch the loop work.

## How the pieces fit

1. The browser (`Chat.tsx`) POSTs `{ messages, input }` to `/api/agent`.
2. The route handler passes `messages` as `history` and `input` as the new user message to `agent.run()`.
3. The agent calls the model; if it asks for tools, they run on the server; results go back to the model; repeat.
4. The handler returns the new messages. The browser appends them and is ready for the next turn.

The server stores nothing between requests (`NullMemory`). See `../../docs/NEXTJS.md` for the alternative
where the server keeps the history keyed by `conversationId`.

## Using a local model

Point the provider at any OpenAI-compatible server. For Ollama:

```
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.1
OPENAI_API_KEY=
```

Tool calling requires a model that supports it.
