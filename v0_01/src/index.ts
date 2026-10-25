/**
 * index.ts — the public surface of `@ajc-dev/app-agent`.
 *
 * Anything *not* exported here is an implementation detail and may change
 * between versions without notice. Consumers should only ever
 * `import { ... } from '@ajc-dev/app-agent'`.
 */

// Core
export { Agent, createAgent } from './agent.js';
export { defineTool, ToolRegistry, parseToolArguments, serializeToolResult, toToolSpec } from './tool.js';
export { InMemoryMemory, NullMemory } from './memory.js';

// Providers
export {
  OpenAICompatibleProvider,
  toWireRequest,
  fromWireResponse,
  type OpenAICompatibleOptions,
} from './providers/openai-compatible.js';
export { MockProvider, toolCallMessage, type MockReply } from './providers/mock.js';

// Errors
export {
  AgentError,
  ProviderError,
  ToolExecutionError,
  UnknownToolError,
  MaxStepsExceededError,
  describeError,
} from './errors.js';

// Types (type-only exports are erased at build time)
export type {
  Role,
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolSpec,
  JsonSchema,
  FinishReason,
  TokenUsage,
  ProviderRequest,
  ProviderResponse,
  LLMProvider,
  Memory,
  AgentEvent,
  AgentOptions,
  RunOptions,
  AgentResult,
} from './types.js';
