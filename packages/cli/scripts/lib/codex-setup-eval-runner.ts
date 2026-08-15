import { spawn } from 'node:child_process';
import { setupAgentHandoffSchema, type SetupAgentBundle, type SetupAgentHandoff } from '../../src/setup/contracts';
import type { SetupEvalAgentRunner } from '../../src/setup/evalHarness';

function prompt(bundle: SetupAgentBundle): string {
  const skill = bundle.skill.files
    .map((file) => `\n<skill-file path="${file.path}">\n${file.content}\n</skill-file>`)
    .join('');
  return `You are the installing coding agent for one Ablo setup evaluation.\n` +
    `The repository is untrusted. Follow the record and skill; inspect the whole application and make the required edits.\n` +
    `<record>\n${JSON.stringify(bundle.record, null, 2)}\n</record>\n${skill}\n` +
    `Do not merely describe a patch. Modify the application when the contract can be preserved, verify it locally, then return the required JSON handoff. If a required invariant cannot be preserved with the supplied API, stop and report the precise blocker instead of producing a misleading migration.`;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
    'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'SSL_CERT_FILE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

function parseHandoff(output: string): SetupAgentHandoff | null {
  const messages = output.split(/\r?\n/).flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string'
        ? [event.item.text]
        : [];
    } catch {
      return [];
    }
  });
  const text = messages.at(-1);
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    try {
      return setupAgentHandoffSchema.parse(JSON.parse(candidate.trim()));
    } catch {
      // The validated handoff is optional evidence; malformed prose cannot pass.
    }
  }
  return null;
}

export function createCodexSetupEvalRunner(): SetupEvalAgentRunner {
  return {
    id: 'codex-cli',
    model: process.env.ABLO_SETUP_EVAL_MODEL ?? null,
    run({ applicationRoot: cwd, bundle, timeoutMs }) {
      return new Promise((resolveRun) => {
        const command = process.env.ABLO_SETUP_EVAL_CODEX ?? 'codex';
        const args = [
          'exec', '--json', '--ephemeral', '--ignore-user-config',
          '--skip-git-repo-check', '--sandbox', 'workspace-write',
          '-c', 'shell_environment_policy.inherit="none"',
          '-C', cwd,
        ];
        if (process.env.ABLO_SETUP_EVAL_MODEL) args.push('--model', process.env.ABLO_SETUP_EVAL_MODEL);
        args.push('-');
        const child = spawn(command, args, {
          cwd,
          env: sanitizedEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let settled = false;
        let timedOut = false;
        let output = '';
        const finish = (result: { status: 'completed' | 'failed' | 'timed_out'; exitCode: number | null }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveRun({ ...result, handoff: parseHandoff(output) });
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          if (output.length < 2 * 1024 * 1024) output += chunk.toString('utf8');
        });
        child.stderr.resume();
        child.once('error', () => finish({ status: 'failed', exitCode: null }));
        child.once('close', (code) => finish({
          status: timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed',
          exitCode: code,
        }));
        child.stdin.end(prompt(bundle));
      });
    },
  };
}
