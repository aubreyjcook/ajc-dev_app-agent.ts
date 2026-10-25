/**
 * agent.ts — the agent loop. This is the heart of the library.
 *
 * An "agent" in this codebase means one thing: a loop that
 *
 *   1. sends the conversation (plus a list of available tools) to a model,
 *   2. looks at the reply —
 *        • if it is plain text, we are done; return it,
 *        • if it asks for tools, run them, append the results, go to 1.
 *
 * That is the entire idea. Everything else (memory, events, errors) is
 * plumbing around those two steps. Read `run()` top to bottom and you will
 * understand how every "agentic" product works at its core.
 */

import type {
  AgentEvent,
  AgentOptions,
  AgentResult,
  AssistantMessage,
  FinishReason,
  LLMProvider,
  Memory,
  Message,
  ProviderRequest,
  RunOptions,
  TokenUsage,
  ToolMessage,
  UserMessage,
} from './types.js';
import { InMemoryMemory } from './memory.js';
import { ToolRegistry } from './tool.js';
import { MaxStepsExceededError, describeError } from './errors.js';

const DEFAULT_MAX_STEPS = 8;

export class Agent {
  readonly provider: LLMProvider;
  readonly memory: Memory;
  readonly tools: ToolRegistry;

  private readonly systemPrompt: string | undefined;
  private readonly maxSteps: number;
  private readonly model: string | undefined;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.memory = options.memory ?? new InMemoryMemory();
    this.tools = new ToolRegistry(options.tools ?? []);
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.model = options.model;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.onEvent = options.onEvent;

    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw new Error(`maxSteps must be a positive integer, got ${String(options.maxSteps)}`);
    }
  }

  /**
   * Run one user turn to completion.
   *
   * @param input   The user's message.
   * @param options `conversationId` to continue a stored conversation,
   *                `history` to supply prior messages directly (client-owned
   *                history), `signal` to cancel.
   */
  async run(input: string, options: RunOptions & { history?: Message[] | undefined } = {}): Promise<AgentResult> {
    const conversationId = options.conversationId ?? randomId();
    const signal = options.signal;

    this.emit({ type: 'run:start', conversationId, input });

    try {
      // --- 1. Assemble the transcript -----------------------------------
      // Stored history first, then any history the caller passed in directly.
      // Both are optional; a brand-new conversation has neither.
      const stored = await this.memory.load(conversationId);
      const prior: Message[] = [...stored, ...(options.history ?? [])];

      const userMessage: UserMessage = { role: 'user', content: input };
      // Everything created during *this* run. Persisted at the end.
      const newMessages: Message[] = [userMessage];
      // The live transcript the model sees (minus the system prompt, which is
      // injected per-request so it can change without rewriting history).
      const transcript: Message[] = [...prior, userMessage];

      let steps = 0;
      const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finishReason: FinishReason = 'other';

      // --- 2. The loop --------------------------------------------------
      while (true) {
        signal?.throwIfAborted();

        if (steps >= this.maxSteps) {
          // Persist what we have so the stored conversation stays consistent
          // (every tool call already has its result), then bail out.
          await this.memory.append(conversationId, newMessages);
          throw new MaxStepsExceededError(this.maxSteps);
        }

        steps += 1;
        this.emit({ type: 'step:start', step: steps });

        const request: ProviderRequest = {
          messages: this.withSystemPrompt(transcript),
          tools: this.tools.specs(),
          model: this.model,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
          signal,
        };
        this.emit({ type: 'llm:request', step: steps, request });

        const response = await this.provider.complete(request);
        this.emit({ type: 'llm:response', step: steps, response });

        addUsage(usage, response.usage);
        finishReason = response.finishReason;

        const assistant: AssistantMessage = response.message;
        newMessages.push(assistant);
        transcript.push(assistant);

        const calls = assistant.toolCalls ?? [];

        // --- 2a. No tool calls → the model is finished -------------------
        if (calls.length === 0) {
          await this.memory.append(conversationId, newMessages);

          const result: AgentResult = {
            text: assistant.content ?? '',
            conversationId,
            newMessages,
            messages: transcript,
            steps,
            finishReason,
            usage,
          };
          this.emit({ type: 'run:end', result });
          return result;
        }

        // --- 2b. Tool calls → run each one, feed results back ------------
        // v0_01 runs tools sequentially for simplicity and predictable logs.
        // Running them concurrently with `Promise.all` is on the roadmap.
        for (const call of calls) {
          signal?.throwIfAborted();
          this.emit({ type: 'tool:start', step: steps, call });

          const started = Date.now();
          let content: string;
          try {
            content = await this.tools.run(call, { signal });
            this.emit({
              type: 'tool:end',
              step: steps,
              call,
              result: content,
              durationMs: Date.now() - started,
            });
          } catch (error) {
            // Policy decision: a failing tool does NOT abort the run. We tell
            // the model what went wrong and let it decide (retry, apologise,
            // try a different tool...). This is what makes agents resilient.
            this.emit({ type: 'tool:error', step: steps, call, error });
            content = `Error: ${describeError(error)}`;
          }

          const toolMessage: ToolMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content,
          };
          newMessages.push(toolMessage);
          transcript.push(toolMessage);
        }
        // ...and around we go: the next iteration sends the tool results to the model.
      }
    } catch (error) {
      this.emit({ type: 'run:error', error });
      throw error;
    }
  }

  /**
   * Build the message list for a model request: system prompt (if any) first,
   * then the transcript. Always returns a *new* array — the live `transcript`
   * keeps growing during the loop, and we must not hand providers or event
   * listeners a reference that mutates under them.
   */
  private withSystemPrompt(transcript: Message[]): Message[] {
    if (!this.systemPrompt) return [...transcript];
    return [{ role: 'system', content: this.systemPrompt }, ...transcript];
  }

  /** Call the user's event hook, never letting a buggy hook break the run. */
  private emit(event: AgentEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      /* swallow — observers must not affect the agent */
    }
  }
}

/** Convenience factory, for people who prefer functions over `new`. */
export function createAgent(options: AgentOptions): Agent {
  return new Agent(options);
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function addUsage(total: TokenUsage, delta: TokenUsage | undefined): void {
  if (!delta) return;
  total.promptTokens = (total.promptTokens ?? 0) + (delta.promptTokens ?? 0);
  total.completionTokens = (total.completionTokens ?? 0) + (delta.completionTokens ?? 0);
  total.totalTokens = (total.totalTokens ?? 0) + (delta.totalTokens ?? 0);
}

/**
 * Generate a conversation id. Uses the Web Crypto API when available (Node 19+,
 * browsers, Edge runtimes) and falls back to a random string otherwise.
 */
function randomId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
