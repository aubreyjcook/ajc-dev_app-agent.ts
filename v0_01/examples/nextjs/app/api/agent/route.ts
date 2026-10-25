/**
 * app/api/agent/route.ts — the HTTP boundary between the browser and the agent.
 *
 * Next.js App Router "route handlers" export functions named after HTTP
 * verbs. This one accepts a POST with the conversation so far plus the new
 * user message, runs the agent, and returns the new messages.
 *
 * Request body:  { "messages": Message[], "input": string }
 * Response body: { "text": string, "messages": Message[] }   (messages = the
 *                 new ones produced by this turn; the client appends them)
 */

import { NextResponse } from 'next/server';
import { AgentError, type Message } from '@ajc-dev/app-agent';
import { agent } from '@/lib/agent';

// The library works on the Edge runtime too (it only uses `fetch`), but the
// Node runtime is the safer default for tools that touch databases, files, etc.
export const runtime = 'nodejs';

interface AgentRequestBody {
  messages?: unknown;
  input?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: AgentRequestBody;
  try {
    body = (await request.json()) as AgentRequestBody;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  // Validate the parts we rely on. (A schema library would do this better;
  // it is left out to keep the example dependency-free.)
  if (typeof body.input !== 'string' || body.input.trim() === '') {
    return NextResponse.json({ error: '`input` must be a non-empty string' }, { status: 400 });
  }
  const history = Array.isArray(body.messages) ? (body.messages as Message[]) : [];

  try {
    // `request.signal` aborts the run if the browser disconnects.
    const result = await agent.run(body.input, { history, signal: request.signal });
    return NextResponse.json({ text: result.text, messages: result.newMessages });
  } catch (error) {
    console.error('[api/agent]', error);
    const message = error instanceof AgentError ? error.message : 'Agent failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
