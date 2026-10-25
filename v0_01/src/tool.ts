/**
 * tool.ts — helpers for defining and running tools.
 *
 * A "tool" is just a named function plus a JSON Schema describing its
 * arguments. The model never *runs* anything; it emits a `ToolCall` saying
 * "please run `get_weather` with `{"city":"Paris"}`", and the agent loop
 * (in `agent.ts`) looks the tool up here and executes it.
 */

import type { ToolCall, ToolContext, ToolDefinition, ToolSpec } from './types.js';
import { ToolExecutionError, UnknownToolError, describeError } from './errors.js';

/**
 * Identity function that exists purely for type inference. Writing
 *
 *   defineTool<{ city: string }>({ ... execute: (args) => args.city })
 *
 * gives `args` the right type inside `execute` without an explicit annotation.
 * It also makes tool definitions easy to grep for.
 */
export function defineTool<TArgs = Record<string, unknown>, TResult = unknown>(
  tool: ToolDefinition<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
    // Most providers enforce this exact rule; failing early gives a clearer error.
    throw new Error(
      `Invalid tool name "${tool.name}": use 1-64 characters from [a-zA-Z0-9_-]`,
    );
  }
  return tool;
}

/** Strip `execute` so a tool can be safely serialized and sent to the model. */
export function toToolSpec(tool: ToolDefinition<any, any>): ToolSpec { // eslint-disable-line @typescript-eslint/no-explicit-any
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/**
 * Parse the raw JSON `arguments` string from a tool call. Models occasionally
 * emit an empty string for zero-arg tools, which we treat as `{}`.
 * Throws `ToolExecutionError` on malformed JSON so the loop can report it.
 */
export function parseToolArguments(call: ToolCall): unknown {
  const raw = call.arguments.trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ToolExecutionError(call.name, `arguments were not valid JSON: ${raw}`, { cause });
  }
}

/** Tool results must be strings for the model; stringify anything that is not already one. */
export function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * A small lookup table of tools by name with a single `run()` entry point.
 * The agent builds one of these from `AgentOptions.tools`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(tools: ToolDefinition<any, any>[] = []) { // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const tool of tools) this.register(tool);
  }

  register(tool: ToolDefinition<any, any>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /** Model-facing specs for every registered tool, or `undefined` if there are none. */
  specs(): ToolSpec[] | undefined {
    if (this.tools.size === 0) return undefined;
    return [...this.tools.values()].map(toToolSpec);
  }

  /**
   * Execute a tool call end to end: look up, parse args, run, serialize.
   *
   * This *throws* on failure (unknown tool, bad JSON, execute error). The agent
   * loop catches and converts the error into a tool message for the model —
   * keeping that policy decision in one place (`agent.ts`) rather than here.
   */
  async run(call: ToolCall, ctx: Omit<ToolContext, 'call'> = {}): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) throw new UnknownToolError(call.name);

    const args = parseToolArguments(call);
    try {
      const result = await tool.execute(args, { ...ctx, call });
      return serializeToolResult(result);
    } catch (cause) {
      if (cause instanceof ToolExecutionError) throw cause;
      throw new ToolExecutionError(call.name, describeError(cause), { cause });
    }
  }
}
