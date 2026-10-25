/**
 * providers/openai-compatible.ts — talk to any "OpenAI-style" chat API.
 *
 * The OpenAI `/chat/completions` request/response shape is supported by a
 * large number of services: OpenAI itself, DeepSeek, Groq, Mistral,
 * OpenRouter, Together, Fireworks, and local servers like Ollama, LM Studio,
 * vLLM and llama.cpp. One adapter therefore covers most of the ecosystem.
 *
 * This file is intentionally dependency-free: it uses the global `fetch`,
 * which exists in Node 18+, browsers, and every Edge runtime. That is also
 * why it works in Next.js route handlers on either runtime.
 *
 * The code is split into three concerns so each is easy to read:
 *   • `toWireRequest()`   — our `ProviderRequest`  → OpenAI JSON body
 *   • `fromWireResponse()`— OpenAI JSON response   → our `ProviderResponse`
 *   • `complete()`        — the HTTP call that glues the two together
 */

import type {
  FinishReason,
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
  ToolSpec,
} from '../types.js';
import { ProviderError } from '../errors.js';

export interface OpenAICompatibleOptions {
  /** Default model, e.g. `gpt-4o-mini`, `deepseek-chat`, `llama3.1`. Overridable per request. */
  model: string;
  /** Bearer token. Optional because local servers (Ollama) usually need none. */
  apiKey?: string | undefined;
  /** API root *without* a trailing slash. Default: `https://api.openai.com/v1`. */
  baseUrl?: string | undefined;
  /** Extra headers (e.g. OpenRouter's `HTTP-Referer`). */
  headers?: Record<string, string> | undefined;
  /**
   * Inject a `fetch` implementation. Defaults to `globalThis.fetch`. Tests pass
   * a fake here so no network is involved.
   */
  fetch?: typeof fetch | undefined;
  /** Label used in errors/events. Default: `openai-compatible`. */
  name?: string | undefined;
}

// ---------------------------------------------------------------------------
// Wire-format types (just enough of the OpenAI schema for what we use)
// ---------------------------------------------------------------------------

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface WireRequest {
  model: string;
  messages: WireMessage[];
  tools?: Array<{ type: 'function'; function: ToolSpec }>;
  temperature?: number;
  max_tokens?: number;
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ---------------------------------------------------------------------------
// Translation: ours → wire
// ---------------------------------------------------------------------------

function toWireMessage(message: Message): WireMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      const wire: WireMessage = { role: 'assistant', content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        wire.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return wire;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

/** Exported for tests and for anyone who wants to inspect the exact payload. */
export function toWireRequest(request: ProviderRequest, defaultModel: string): WireRequest {
  const body: WireRequest = {
    model: request.model ?? defaultModel,
    messages: request.messages.map(toWireMessage),
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({ type: 'function', function: tool }));
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  return body;
}

// ---------------------------------------------------------------------------
// Translation: wire → ours
// ---------------------------------------------------------------------------

function toFinishReason(reason: string | null | undefined, hasToolCalls: boolean): FinishReason {
  // Some servers report `stop` even when tool calls are present; trust the data.
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'other';
  }
}

/** Exported for tests. Throws `ProviderError` if the body is not shaped as expected. */
export function fromWireResponse(body: unknown, providerName: string): ProviderResponse {
  const data = body as WireResponse;
  const choice = data?.choices?.[0];
  if (!choice || !choice.message) {
    throw new ProviderError(providerName, 'response contained no choices[0].message', { body });
  }

  const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments ?? '',
  }));
  const hasToolCalls = !!toolCalls && toolCalls.length > 0;

  return {
    message: {
      role: 'assistant',
      content: choice.message.content ?? null,
      ...(hasToolCalls ? { toolCalls } : {}),
    },
    finishReason: toFinishReason(choice.finish_reason, hasToolCalls),
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name ?? 'openai-compatible';
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.headers = options.headers ?? {};

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error(`${this.name}: no fetch implementation available; pass one via options.fetch`);
    }
    this.fetchImpl = fetchImpl;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = toWireRequest(request, this.model);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.headers,
    };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal ?? null,
      });
    } catch (cause) {
      // Re-throw aborts untouched so callers can distinguish "cancelled" from "failed".
      if (isAbortError(cause)) throw cause;
      throw new ProviderError(this.name, `network error calling ${url}`, { cause });
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text; // keep the raw text for the error message
    }

    if (!response.ok) {
      throw new ProviderError(this.name, `HTTP ${response.status} from ${url}: ${summarize(json)}`, {
        status: response.status,
        body: json,
      });
    }

    return fromWireResponse(json, this.name);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Trim an error body to something log-friendly. */
function summarize(body: unknown): string {
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  return str && str.length > 500 ? `${str.slice(0, 500)}…` : (str ?? '');
}
