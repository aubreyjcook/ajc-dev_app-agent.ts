/**
 * types.ts — the shared vocabulary of the agent.
 *
 * Everything else in `src/` imports from here. If you are reading the code to
 * learn how it works, start with this file: once you know what a `Message`, a
 * `ToolCall`, and an `LLMProvider` are, the rest of the code is just moving
 * those values around.
 *
 * These types are deliberately *provider-neutral*. They look a lot like the
 * OpenAI chat format because that format has become the de facto standard,
 * but nothing here is tied to one vendor. Adapters in `providers/` translate
 * between these types and whatever a specific API expects.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A chat transcript is an ordered list of messages, each tagged with a role.
 *
 * - `system`    — instructions for the model (persona, rules). Usually first.
 * - `user`      — what the human (or calling code) said.
 * - `assistant` — what the model said. May contain tool calls instead of text.
 * - `tool`      — the result of running a tool call, fed back to the model.
 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

/**
 * The model's reply. When the model decides to use tools, `content` is often
 * `null` and `toolCalls` lists what it wants to run. When it is done, `content`
 * holds the final answer and `toolCalls` is absent/empty.
 */
export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
}

/**
 * The output of a tool, addressed back to the specific `ToolCall` that asked
 * for it via `toolCallId`. Content is always a string because that is what the
 * model reads; we `JSON.stringify` non-string results before building this.
 */
export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  /** Echo of the tool name. Not all APIs need it, but it helps when debugging. */
  name: string;
  content: string;
}

/** Discriminated union — switch on `message.role` to narrow the type. */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * A request from the model to run a tool. `arguments` is the *raw JSON string*
 * the model produced. We keep it raw (not parsed) at this layer because models
 * sometimes emit malformed JSON, and the agent loop needs to decide how to
 * handle that rather than crashing inside a type.
 */
export interface ToolCall {
  /** Opaque id assigned by the provider; used to match results to calls. */
  id: string;
  name: string;
  arguments: string;
}

/**
 * A JSON Schema object describing a tool's parameters. We intentionally type
 * this loosely (`Record<string, unknown>`) rather than depending on a schema
 * library — the schema is passed straight through to the model, which is the
 * only consumer that actually validates against it. See `ROADMAP.md` for
 * the plan to add optional runtime validation.
 */
export type JsonSchema = Record<string, unknown>;

/** Extra information handed to a tool when it runs. */
export interface ToolContext {
  /** The call that triggered this execution (id, raw arguments, etc.). */
  call: ToolCall;
  /** Abort signal propagated from `agent.run()`; long-running tools should honor it. */
  signal?: AbortSignal | undefined;
}

/**
 * A tool the agent can use. The three "spec" fields (`name`, `description`,
 * `parameters`) are sent to the model so it knows the tool exists; `execute`
 * stays on the server and is called by the agent loop when the model asks.
 *
 * `TArgs` is the parsed-argument type your `execute` expects. In v0_01 the
 * agent parses JSON and casts — it does *not* validate the shape. Treat args
 * as untrusted input inside `execute`.
 */
export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: TArgs, ctx: ToolContext) => TResult | Promise<TResult>;
}

/** Just the model-facing part of a tool (no `execute`). This is what providers send over the wire. */
export type ToolSpec = Pick<ToolDefinition, 'name' | 'description' | 'parameters'>;

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

/**
 * Why the model stopped generating.
 * - `stop`       — natural end of a reply.
 * - `tool_calls` — it wants tools run; see `message.toolCalls`.
 * - `length`     — hit the max-token limit (reply may be truncated).
 * - `other`      — anything else (content filter, unknown reason...).
 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface TokenUsage {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
}

/** What the agent hands to a provider for a single model call. */
export interface ProviderRequest {
  messages: Message[];
  tools?: ToolSpec[] | undefined;
  /** Per-request overrides. Providers fall back to their own defaults. */
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** What a provider returns from a single model call. */
export interface ProviderResponse {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage?: TokenUsage | undefined;
  /** The untouched response body, for debugging or provider-specific fields. */
  raw?: unknown;
}

/**
 * The one interface every model backend must implement. The agent loop knows
 * nothing about HTTP, API keys, or vendors — it only knows how to call
 * `complete()`. Swap providers without touching the loop.
 */
export interface LLMProvider {
  /** Human-readable identifier, surfaced in events and errors. */
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

// ---------------------------------------------------------------------------
// Memory contract
// ---------------------------------------------------------------------------

/**
 * Where conversation history lives between `agent.run()` calls. The default
 * implementation is a `Map` in process memory; a real app would back this
 * with a database or the client's own state. Keyed by `conversationId` so
 * one agent can serve many concurrent conversations.
 */
export interface Memory {
  load(conversationId: string): Promise<Message[]>;
  /** Append new messages to the stored transcript (create it if missing). */
  append(conversationId: string, messages: Message[]): Promise<void>;
  clear(conversationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent events (observability hooks)
// ---------------------------------------------------------------------------

/**
 * The agent emits one of these at each interesting moment. Subscribe via
 * `AgentOptions.onEvent` to log, trace, or stream progress to a UI. In v0_01
 * this is the *only* way to observe a run while it is in progress — token
 * streaming is on the roadmap.
 */
export type AgentEvent =
  | { type: 'run:start'; conversationId: string; input: string }
  | { type: 'step:start'; step: number }
  | { type: 'llm:request'; step: number; request: ProviderRequest }
  | { type: 'llm:response'; step: number; response: ProviderResponse }
  | { type: 'tool:start'; step: number; call: ToolCall }
  | { type: 'tool:end'; step: number; call: ToolCall; result: string; durationMs: number }
  | { type: 'tool:error'; step: number; call: ToolCall; error: unknown }
  | { type: 'run:end'; result: AgentResult }
  | { type: 'run:error'; error: unknown };

// ---------------------------------------------------------------------------
// Agent API
// ---------------------------------------------------------------------------

export interface AgentOptions {
  provider: LLMProvider;
  /** Prepended to every conversation as a `system` message. */
  systemPrompt?: string | undefined;
  tools?: ToolDefinition<any, any>[] | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * Safety valve: the maximum number of model calls in one `run()`. Each
   * tool round-trip costs a step. Prevents infinite tool loops. Default 8.
   */
  maxSteps?: number | undefined;
  /** Where to persist history. Defaults to `new InMemoryMemory()`. */
  memory?: Memory | undefined;
  /** Default model params forwarded to the provider on each request. */
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
}

export interface RunOptions {
  /**
   * Identifies the conversation in `Memory`. Omit for a one-shot, stateless
   * call (a fresh random id is generated and nothing is remembered afterwards
   * unless you keep the returned transcript yourself).
   */
  conversationId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface AgentResult {
  /** The model's final text answer (empty string if it produced none). */
  text: string;
  conversationId: string;
  /** Every message added during this run, in order (user, assistant, tool, assistant...). */
  newMessages: Message[];
  /** The full transcript after this run, including prior history. */
  messages: Message[];
  /** Number of model calls made. */
  steps: number;
  finishReason: FinishReason;
  usage: TokenUsage;
}
