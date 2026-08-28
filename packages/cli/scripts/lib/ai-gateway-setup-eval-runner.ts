import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import {
  setupAgentHandoffSchema,
  type SetupAgentBundle,
  type SetupAgentHandoff,
} from '../../src/setup/contracts';
import type { SetupEvalAgentRunner } from '../../src/setup/evalHarness';

const SYSTEM = `You are a fresh coding agent in a disposable application repository.
You have no prior conversation, memory, or private product context. The task and
public documentation available in this run are your only Ablo instructions.
Inspect before editing, implement the task, and run the checks. Do not merely
describe a patch. Stop when the implementation passes or when the documented
API cannot preserve a required boundary. End every run by calling submitHandoff
exactly once with the outcome and evidence.`;

export type DocumentationAccess = 'injected' | 'browsable';
export type TaskPresentation = 'contract' | 'user-request';

function resolveWorkspacePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error('Path escapes the disposable application root.');
  }
  const local = relative(root, absolute);
  if (local.split(sep).some((part) => part.startsWith('.env'))) {
    throw new Error('Environment files are outside the evaluation scope.');
  }
  return absolute;
}

function listWorkspaceFiles(root: string, path = '.'): string[] {
  const files: string[] = [];
  const start = resolveWorkspacePath(root, path);
  if (!statSync(start).isDirectory()) throw new Error('Path is not a directory.');
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.env')) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute));
      if (files.length >= 500) return;
    }
  };
  visit(start);
  return files.sort();
}

function prompt(
  bundle: SetupAgentBundle,
  documentationAccess: DocumentationAccess,
  taskPresentation: TaskPresentation,
): string {
  const docs = bundle.skill.files.filter(({ path }) => path.startsWith('references/')).map((file) =>
    `<file path="${file.path}" sha256="${file.sha256}">\n${file.content}\n</file>`
  ).join('\n\n');
  const task = taskPresentation === 'user-request'
    ? bundle.record.objective
    : JSON.stringify({
        objective: bundle.record.objective,
        constraints: bundle.record.constraints,
        acceptanceCriteria: bundle.record.acceptanceCriteria,
        candidateWritePaths: bundle.record.discoveryHints.map(({ path, line, operation }) => ({
          path,
          line,
          operation,
        })),
      }, null, 2);
  const documentation = documentationAccess === 'injected'
    ? `<public-documentation>\n${docs}\n</public-documentation>`
    : '<public-documentation>The public documentation is available through the read-only documentation tools. Decide what to inspect.</public-documentation>';
  return `<task>\n${task}\n</task>\n\n${documentation}`;
}

export function createAiGatewaySetupEvalRunner(
  model: string,
  options: {
    readonly documentationAccess?: DocumentationAccess;
    readonly taskPresentation?: TaskPresentation;
  } = {},
): SetupEvalAgentRunner {
  const documentationAccess = options.documentationAccess ?? 'injected';
  const taskPresentation = options.taskPresentation ?? 'contract';
  return {
    id: `vercel-ai-gateway-${documentationAccess}`,
    model,
    async run({ applicationRoot, bundle, timeoutMs }) {
      if (!process.env.AI_GATEWAY_API_KEY) {
        throw new Error('AI_GATEWAY_API_KEY is required for a real docs eval.');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let lastCheck: { command: string; exitCode: number | null; result: string } | null = null;
      const documentationReads: string[] = [];
      let documentationReadWords = 0;
      const documentationSearches: string[] = [];
      const repositoryReads: string[] = [];
      const writes: string[] = [];
      let documentationLists = 0;
      let repositoryLists = 0;
      let checks = 0;
      const documentationFiles = new Map(
        bundle.skill.files
          .filter(({ path }) => path.startsWith('references/'))
          .map((file) => [file.path, file.content]),
      );
      const telemetry = () => ({
        documentationLists,
        documentationReads: [...documentationReads],
        documentationReadWords,
        documentationSearches: [...documentationSearches],
        repositoryLists,
        repositoryReads: [...repositoryReads],
        writes: [...writes],
        checks,
      });
      try {
        let submittedHandoff: SetupAgentHandoff | null = null;
        await generateText({
          model,
          system: SYSTEM,
          prompt: prompt(bundle, documentationAccess, taskPresentation),
          abortSignal: controller.signal,
          stopWhen: stepCountIs(30),
          tools: {
            ...(documentationAccess === 'browsable' ? {
              listDocumentation: tool({
                description: 'List the paths in the read-only public Ablo documentation library.',
                inputSchema: z.object({ prefix: z.string().optional() }),
                execute: async ({ prefix }) => {
                  documentationLists += 1;
                  const normalized = prefix?.replace(/^\/+/, '') ?? '';
                  return {
                    files: [...documentationFiles.keys()]
                      .filter((path) => path.slice('references/'.length).startsWith(normalized))
                      .sort(),
                  };
                },
              }),
              readDocumentation: tool({
                description: 'Read one public Ablo documentation file returned by listDocumentation.',
                inputSchema: z.object({ path: z.string().min(1) }),
                execute: async ({ path }) => {
                  const normalized = path.startsWith('references/') ? path : `references/${path.replace(/^\/+/, '')}`;
                  const content = documentationFiles.get(normalized);
                  if (content === undefined) throw new Error('Documentation path was not found.');
                  documentationReads.push(normalized);
                  documentationReadWords += content.match(/\S+/g)?.length ?? 0;
                  return { path: normalized, content: content.slice(0, 50_000) };
                },
              }),
              searchDocumentation: tool({
                description: 'Search all public Ablo documentation files for text, like a bounded case-insensitive rg search.',
                inputSchema: z.object({ query: z.string().min(2) }),
                execute: async ({ query }) => {
                  documentationSearches.push(query);
                  const needle = query.toLocaleLowerCase();
                  const matches: Array<{ path: string; line: number; text: string }> = [];
                  for (const [path, content] of documentationFiles) {
                    for (const [index, line] of content.split('\n').entries()) {
                      if (!line.toLocaleLowerCase().includes(needle)) continue;
                      matches.push({ path, line: index + 1, text: line.slice(0, 500) });
                      if (matches.length >= 50) return { matches, truncated: true };
                    }
                  }
                  return { matches, truncated: false };
                },
              }),
            } : {}),
            listFiles: tool({
              description: 'List files below one repository-relative directory (defaults to the repository root).',
              inputSchema: z.object({ path: z.string().min(1).optional() }),
              execute: async ({ path }) => {
                repositoryLists += 1;
                return { files: listWorkspaceFiles(applicationRoot, path) };
              },
            }),
            readFile: tool({
              description: 'Read one UTF-8 application file by repository-relative path.',
              inputSchema: z.object({ path: z.string().min(1) }),
              execute: async ({ path }) => {
                const absolute = resolveWorkspacePath(applicationRoot, path);
                if (!statSync(absolute).isFile()) throw new Error('Path is not a file.');
                repositoryReads.push(path);
                return { path, content: readFileSync(absolute, 'utf8').slice(0, 50_000) };
              },
            }),
            writeFile: tool({
              description: 'Replace one UTF-8 application file by repository-relative path.',
              inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
              execute: async ({ path, content }) => {
                const absolute = resolveWorkspacePath(applicationRoot, path);
                if (!statSync(absolute).isFile()) {
                  throw new Error('The docs eval only permits editing existing files.');
                }
                writeFileSync(absolute, content, 'utf8');
                writes.push(path);
                return { path, written: true };
              },
            }),
            runTypecheck: tool({
              description: 'Run the fixture strict TypeScript check and return bounded diagnostics.',
              inputSchema: z.object({}),
              execute: async () => {
                checks += 1;
                const tsc = resolve(import.meta.dirname, '../../../../node_modules/.bin/tsc');
                const result = spawnSync(tsc, ['-p', 'tsconfig.json', '--noEmit'], {
                  cwd: applicationRoot,
                  encoding: 'utf8',
                  timeout: 30_000,
                });
                lastCheck = {
                  command: 'tsc -p tsconfig.json --noEmit',
                  exitCode: result.status,
                  result: `${result.stdout}${result.stderr}`.slice(0, 4_000) || 'TypeScript passed.',
                };
                return lastCheck;
              },
            }),
            submitHandoff: tool({
              description: 'Submit the final implementation handoff. Use outcome blocked and make no edits when the documented API cannot preserve a required application boundary.',
              inputSchema: setupAgentHandoffSchema,
              execute: async (input) => {
                submittedHandoff = setupAgentHandoffSchema.parse(input);
                return { accepted: true };
              },
            }),
          },
        });
        if (!submittedHandoff) {
          throw new Error('The agent stopped without submitting the required structured handoff.');
        }
        return { status: 'completed', exitCode: 0, handoff: submittedHandoff, telemetry: telemetry() };
      } catch (error) {
        return {
          status: controller.signal.aborted ? 'timed_out' : 'failed',
          exitCode: null,
          handoff: {
            outcome: 'failed',
            changedFiles: [],
            exploredWritePaths: [],
            directWriteExceptions: [],
            verification: lastCheck ? [lastCheck] : [],
            blockers: [error instanceof Error ? error.message : 'AI Gateway evaluation failed.'],
          },
          telemetry: telemetry(),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
