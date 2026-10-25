import { describe, expect, it } from 'vitest';
import {
  ToolExecutionError,
  ToolRegistry,
  UnknownToolError,
  defineTool,
  parseToolArguments,
  serializeToolResult,
} from '../src/index.js';

describe('defineTool', () => {
  it('returns the definition unchanged', () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      execute: (args) => args,
    });
    expect(tool.name).toBe('echo');
  });

  it('rejects invalid names early', () => {
    expect(() =>
      defineTool({ name: 'has space', description: '', parameters: {}, execute: () => null }),
    ).toThrow(/Invalid tool name/);
  });
});

describe('parseToolArguments', () => {
  it('treats an empty string as {}', () => {
    expect(parseToolArguments({ id: '1', name: 't', arguments: '' })).toEqual({});
  });

  it('parses JSON', () => {
    expect(parseToolArguments({ id: '1', name: 't', arguments: '{"x":1}' })).toEqual({ x: 1 });
  });

  it('throws ToolExecutionError on malformed JSON', () => {
    expect(() => parseToolArguments({ id: '1', name: 't', arguments: '{oops' })).toThrow(ToolExecutionError);
  });
});

describe('serializeToolResult', () => {
  it('passes strings through and stringifies everything else', () => {
    expect(serializeToolResult('hi')).toBe('hi');
    expect(serializeToolResult({ a: 1 })).toBe('{"a":1}');
    expect(serializeToolResult(42)).toBe('42');
    expect(serializeToolResult(undefined)).toBe('');
  });
});

describe('ToolRegistry', () => {
  const upper = defineTool<{ text: string }, string>({
    name: 'upper',
    description: 'uppercase',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: ({ text }, ctx) => `${text.toUpperCase()}:${ctx.call.id}`,
  });

  it('rejects duplicate names', () => {
    expect(() => new ToolRegistry([upper, upper])).toThrow(/Duplicate/);
  });

  it('returns undefined specs when empty', () => {
    expect(new ToolRegistry().specs()).toBeUndefined();
  });

  it('runs a tool with parsed args and context', async () => {
    const registry = new ToolRegistry([upper]);
    const out = await registry.run({ id: 'abc', name: 'upper', arguments: '{"text":"hey"}' });
    expect(out).toBe('HEY:abc');
  });

  it('throws UnknownToolError for unregistered names', async () => {
    const registry = new ToolRegistry([upper]);
    await expect(registry.run({ id: '1', name: 'missing', arguments: '{}' })).rejects.toBeInstanceOf(UnknownToolError);
  });

  it('wraps execute failures in ToolExecutionError', async () => {
    const bad = defineTool({
      name: 'bad',
      description: '',
      parameters: {},
      execute: () => Promise.reject(new Error('nope')),
    });
    const registry = new ToolRegistry([bad]);
    await expect(registry.run({ id: '1', name: 'bad', arguments: '{}' })).rejects.toThrow('Tool "bad" failed: nope');
  });
});
