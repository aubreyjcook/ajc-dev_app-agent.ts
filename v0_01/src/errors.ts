/**
 * errors.ts — typed error classes.
 *
 * Throwing *specific* error subclasses (instead of plain `Error`) lets calling
 * code decide what to do with `instanceof` checks: retry on a `ProviderError`
 * with status 429, show a friendly message on `MaxStepsExceededError`, etc.
 *
 * Every class sets `this.name` so stack traces and logs read well.
 */

/** Base class for everything this library throws. Catch this to catch all. */
export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentError';
  }
}

/** The model backend returned a non-2xx response or unparseable body. */
export class ProviderError extends AgentError {
  readonly provider: string;
  readonly status: number | undefined;
  readonly body: unknown;

  constructor(
    provider: string,
    message: string,
    details: { status?: number | undefined; body?: unknown; cause?: unknown } = {},
  ) {
    super(`[${provider}] ${message}`, { cause: details.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = details.status;
    this.body = details.body;
  }
}

/**
 * A tool's `execute` threw. By default the agent loop *catches* this and
 * reports the failure back to the model as a tool result (so the model can
 * recover). It is exported so you can throw it yourself from a tool when you
 * want a clean message to reach the model.
 */
export class ToolExecutionError extends AgentError {
  readonly toolName: string;

  constructor(toolName: string, message: string, options?: { cause?: unknown }) {
    super(`Tool "${toolName}" failed: ${message}`, options);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
  }
}

/** The model asked for a tool the agent does not have. Also reported back to the model. */
export class UnknownToolError extends AgentError {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Unknown tool "${toolName}"`);
    this.name = 'UnknownToolError';
    this.toolName = toolName;
  }
}

/** The loop ran `maxSteps` model calls without reaching a final text answer. */
export class MaxStepsExceededError extends AgentError {
  readonly steps: number;

  constructor(steps: number) {
    super(`Agent exceeded the maximum of ${steps} steps without finishing`);
    this.name = 'MaxStepsExceededError';
    this.steps = steps;
  }
}

/** Converts any thrown value to a readable string — for tool results and logs. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
