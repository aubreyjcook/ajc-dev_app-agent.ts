/**
 * lib/agent.ts — server-only agent setup.
 *
 * This module is imported by the route handler and runs on the server, so it
 * is safe to read secrets from `process.env` here. Never import this file
 * from a client component ("use client") or your API key would be bundled
 * into the browser.
 *
 * The agent is created once at module scope and reused across requests. It
 * holds no per-conversation state (we use `NullMemory` and let the browser
 * own the transcript), so sharing it is safe.
 */

import { Agent, NullMemory, OpenAICompatibleProvider, defineTool } from '@ajc-dev/app-agent';

// --- Tools -----------------------------------------------------------------
// Each tool = a name + description + JSON Schema for its args + a function.
// The model only sees the first three; `execute` runs here on the server.

const getCurrentTime = defineTool<{ timeZone?: string }, string>({
  name: 'get_current_time',
  description: 'Get the current date and time. Optionally in a specific IANA time zone, e.g. "Europe/Paris".',
  parameters: {
    type: 'object',
    properties: {
      timeZone: { type: 'string', description: 'IANA time zone name. Defaults to UTC.' },
    },
  },
  execute: ({ timeZone }) => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: timeZone ?? 'UTC',
      }).format(new Date());
    } catch {
      // Thrown errors are reported back to the model as a tool result, so it
      // can correct itself (e.g. ask the user for a valid zone).
      throw new Error(`Unknown time zone "${timeZone}"`);
    }
  },
});

const rollDice = defineTool<{ sides?: number; count?: number }, { rolls: number[]; total: number }>({
  name: 'roll_dice',
  description: 'Roll one or more dice and return the results.',
  parameters: {
    type: 'object',
    properties: {
      sides: { type: 'integer', minimum: 2, description: 'Faces per die. Default 6.' },
      count: { type: 'integer', minimum: 1, maximum: 20, description: 'How many dice. Default 1.' },
    },
  },
  execute: ({ sides = 6, count = 1 }) => {
    // Treat model-provided args as untrusted: clamp them.
    const s = Math.max(2, Math.min(1000, Math.floor(sides)));
    const c = Math.max(1, Math.min(20, Math.floor(count)));
    const rolls = Array.from({ length: c }, () => 1 + Math.floor(Math.random() * s));
    return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
  },
});

// --- Provider --------------------------------------------------------------

const provider = new OpenAICompatibleProvider({
  model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
});

// --- Agent -----------------------------------------------------------------

export const agent = new Agent({
  provider,
  tools: [getCurrentTime, rollDice],
  systemPrompt:
    'You are a concise, friendly assistant embedded in a website. Use tools when they help answer accurately.',
  // The browser sends the full transcript with each request, so the server
  // keeps nothing. Swap in `InMemoryMemory` (dev only) or your own `Memory`
  // implementation to keep history server-side instead.
  memory: new NullMemory(),
  maxSteps: 6,
  // Events are a cheap way to see what the agent is doing in the server log.
  onEvent: (event) => {
    if (event.type === 'tool:start') console.log(`[agent] tool → ${event.call.name}(${event.call.arguments})`);
    if (event.type === 'tool:error') console.warn(`[agent] tool ✗ ${event.call.name}`, event.error);
    if (event.type === 'run:end') console.log(`[agent] done in ${event.result.steps} step(s)`);
  },
});
