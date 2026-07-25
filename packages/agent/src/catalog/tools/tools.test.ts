/**
 * Tool ports integration tests.
 *
 * Tests every ported tool end-to-end against a real DefaultSandbox +
 * ScratchBackend. Verifies that the open-agents tool shape works
 * natively with our Sandbox interface, with no adapter code.
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../../perception/index.js';
import { DefaultSandbox } from '../../primitives/sandbox';
import { ScratchBackend } from '../../primitives/sandbox/virtual-fs';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  todoWriteTool,
  askUserQuestionTool,
} from './index';
import type { AgentContext } from '../../types';

// ── Test fixture ──────────────────────────────────────────────────────────

function makePerception(): Agent {
  return new Agent({
    syncServerUrl: 'http://localhost:8080',
    agentId: 'test',
    organizationId: 'org-1',
    syncGroups: ['default'],
    fetch: (async () =>
      new Response('{"entries":[]}', { status: 200 })) as typeof fetch,
  });
}

function makeFixture() {
  const sandbox = new DefaultSandbox({
    backends: [new ScratchBackend()],
    api: {},
    workingDirectory: '/scratch',
  });
  const perception = makePerception();
  const ctx: AgentContext = { perception, sandbox };
  return { sandbox, ctx };
}

const exec = (() => 'tool-call-1') satisfies () => string;

// ── Tests ─────────────────────────────────────────────────────────────────

describe('readFileTool', () => {
  it('reads a file and returns numbered lines', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/hello.txt', 'line a\nline b\nline c');
    const tool = readFileTool();
    const result = await tool.execute!(
      { filePath: 'hello.txt' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.totalLines).toBe(3);
      expect(result.content).toContain('1: line a');
      expect(result.content).toContain('3: line c');
    }
  });

  it('respects offset and limit', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile(
      '/scratch/big.txt',
      Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    const tool = readFileTool();
    const result = await tool.execute!(
      { filePath: 'big.txt', offset: 5, limit: 2 },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.startLine).toBe(5);
      expect(result.endLine).toBe(6); // exclusive — read 2 lines starting at 5
      expect(result.content).toContain('5: line 5');
      expect(result.content).toContain('6: line 6');
      expect(result.content).not.toContain('7: line 7');
    }
  });

  it('returns failure for missing file', async () => {
    const { ctx } = makeFixture();
    const tool = readFileTool();
    const result = await tool.execute!(
      { filePath: 'missing.txt' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(false);
  });
});

describe('writeFileTool', () => {
  it('writes a new file under the working directory', async () => {
    const { sandbox, ctx } = makeFixture();
    const tool = writeFileTool();
    const result = await tool.execute!(
      { filePath: 'new.txt', content: 'hello world' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.path).toBe('/scratch/new.txt');
      expect(result.bytesWritten).toBe(11);
    }
    expect(await sandbox.readFile('/scratch/new.txt')).toBe('hello world');
  });

  it('overwrites existing files', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/x.txt', 'old');
    const tool = writeFileTool();
    await tool.execute!(
      { filePath: 'x.txt', content: 'new' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(await sandbox.readFile('/scratch/x.txt')).toBe('new');
  });
});

describe('editFileTool', () => {
  it('replaces a unique substring', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/main.ts', 'const x = 1;');
    const tool = editFileTool();
    const result = await tool.execute!(
      { filePath: 'main.ts', oldString: 'x = 1', newString: 'x = 42' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    expect(await sandbox.readFile('/scratch/main.ts')).toBe('const x = 42;');
  });

  it('fails when oldString appears multiple times without replaceAll', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/main.ts', 'const x = 1; const x = 2;');
    const tool = editFileTool();
    const result = await tool.execute!(
      { filePath: 'main.ts', oldString: 'const x', newString: 'let x' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(false);
  });

  it('replaces all occurrences with replaceAll: true', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/main.ts', 'foo + foo + foo');
    const tool = editFileTool();
    const result = await tool.execute!(
      { filePath: 'main.ts', oldString: 'foo', newString: 'bar', replaceAll: true },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.replacements).toBe(3);
    }
    expect(await sandbox.readFile('/scratch/main.ts')).toBe('bar + bar + bar');
  });

  it('rejects identical oldString and newString', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/main.ts', 'x');
    const tool = editFileTool();
    const result = await tool.execute!(
      { filePath: 'main.ts', oldString: 'x', newString: 'x' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(false);
  });
});

describe('globTool', () => {
  it('finds files matching a workspace-relative pattern', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/a.ts', '');
    await sandbox.writeFile('/scratch/b.ts', '');
    await sandbox.writeFile('/scratch/sub/c.ts', '');

    const tool = globTool();
    const result = await tool.execute!(
      { pattern: '**/*.ts' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.matches).toContain('/scratch/a.ts');
      expect(result.matches).toContain('/scratch/b.ts');
      expect(result.matches).toContain('/scratch/sub/c.ts');
    }
  });

  it('truncates results when over the limit', async () => {
    const { sandbox, ctx } = makeFixture();
    for (let i = 0; i < 5; i++) {
      await sandbox.writeFile(`/scratch/f${i}.txt`, '');
    }
    const tool = globTool();
    const result = await tool.execute!(
      { pattern: '*.txt', limit: 2 },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.matches).toHaveLength(2);
      expect(result.truncated).toBe(true);
    }
  });
});

describe('grepTool', () => {
  it('finds lines matching a regex', async () => {
    const { sandbox, ctx } = makeFixture();
    await sandbox.writeFile('/scratch/a.ts', 'createLayer({})');
    await sandbox.writeFile('/scratch/b.ts', 'function foo() {}');

    const tool = grepTool();
    const result = await tool.execute!(
      { pattern: 'createLayer' },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.matches).toHaveLength(1);
      const [firstMatch] = result.matches;
      expect(firstMatch?.path).toBe('/scratch/a.ts');
    }
  });
});

describe('todoWriteTool', () => {
  it('returns the todos passed in', async () => {
    const { ctx } = makeFixture();
    const tool = todoWriteTool();
    const result = await tool.execute!(
      {
        todos: [
          { id: '1', content: 'Read the slide', status: 'todo' },
          { id: '2', content: 'Edit the title', status: 'in-progress' },
        ],
      },
      { toolCallId: exec(), messages: [], experimental_context: ctx },
    );
    expect(result.success).toBe(true);
    expect(result.todos).toHaveLength(2);
    expect(result.message).toContain('2 items');
  });
});

describe('askUserQuestionTool', () => {
  it('has no execute function (client-side tool)', () => {
    const tool = askUserQuestionTool() as { execute?: unknown };
    expect(tool.execute).toBeUndefined();
  });

  it('toModelOutput formats answers for the LLM', () => {
    const tool = askUserQuestionTool();
    const formatted = tool.toModelOutput!({
      output: { answers: { 'What color?': 'Blue', 'Which size?': ['M', 'L'] } },
      // toolCallId / args required by AI SDK type but not used by our formatter
      toolCallId: 't1',
      input: { questions: [] },
      messages: [],
    } as Parameters<NonNullable<typeof tool.toModelOutput>>[0]);
    expect(formatted.type).toBe('text');
    if (formatted.type === 'text') {
      expect(formatted.value).toContain('"What color?"="Blue"');
      expect(formatted.value).toContain('"Which size?"="M, L"');
    }
  });

  it('toModelOutput handles declined response', () => {
    const tool = askUserQuestionTool();
    const formatted = tool.toModelOutput!({
      output: { declined: true },
      toolCallId: 't1',
      input: { questions: [] },
      messages: [],
    } as Parameters<NonNullable<typeof tool.toModelOutput>>[0]);
    if (formatted.type === 'text') {
      expect(formatted.value).toContain('declined');
    }
  });
});
