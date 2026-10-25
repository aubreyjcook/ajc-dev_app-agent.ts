'use client';

/**
 * components/Chat.tsx — a deliberately plain chat UI.
 *
 * "use client" marks this as a Client Component: it runs in the browser and
 * can use state and event handlers. It never imports the agent itself — it
 * only talks to `/api/agent` over HTTP, so no secrets reach the browser.
 *
 * The browser owns the transcript: `messages` holds every message so far and
 * is sent with each request. The server is stateless.
 */

import { useState, type FormEvent } from 'react';
import type { Message } from '@ajc-dev/app-agent';

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || pending) return;

    setInput('');
    setError(null);
    setPending(true);

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, input: text }),
      });
      const data = (await response.json()) as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);

      // Append the new turn (user + any tool calls/results + final answer).
      setMessages((prev) => [...prev, ...(data.messages ?? [])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <ol style={{ listStyle: 'none', padding: 0 }}>
        {messages.map((message, index) => (
          <li key={index} style={{ margin: '8px 0', opacity: message.role === 'tool' ? 0.6 : 1 }}>
            <strong>{label(message)}</strong> {render(message)}
          </li>
        ))}
        {pending && <li style={{ opacity: 0.6 }}>thinking…</li>}
      </ol>

      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask something… try: what time is it in Tokyo? or roll 3 dice"
          disabled={pending}
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={pending || !input.trim()}>
          Send
        </button>
        <button type="button" onClick={() => setMessages([])} disabled={pending}>
          Clear
        </button>
      </form>
    </div>
  );
}

function label(message: Message): string {
  switch (message.role) {
    case 'user':
      return 'You:';
    case 'assistant':
      return 'Agent:';
    case 'tool':
      return `↳ ${message.name}:`;
    case 'system':
      return 'System:';
  }
}

function render(message: Message): string {
  if (message.role === 'assistant') {
    if (message.content) return message.content;
    // An assistant message with only tool calls — show what it asked for.
    return (message.toolCalls ?? []).map((c) => `${c.name}(${c.arguments})`).join(', ');
  }
  return message.content;
}
