/**
 * `ablo feedback` — the channel a stuck agent reports through.
 *
 * Every other surface here reports what an agent DID: telemetry counts the
 * commands, the error observer catches the crashes. Neither can carry the two
 * things worth most, because neither is a sentence: the doc that was missing,
 * and the thing that worked but was hard. An agent knows both at the moment it
 * is blocked, and until now had nowhere to put them.
 *
 * Two properties make it safe to hand an agent a network write:
 *
 *   - It is never automatic. Nothing on this path fires without the command
 *     being run, and nothing rides the telemetry queue, so disabling telemetry
 *     cannot silently mean "and stop reporting bugs" in either direction.
 *   - The prose is redacted before it leaves, through the same
 *     `redactObservationString` every error observation already passes, and on
 *     a terminal the redacted text is shown before it is sent. What the
 *     reporter approves is exactly what travels.
 *
 * Nothing is read from the repository. The report contains what the reporter
 * chose to write plus the version and platform it wrote it on. There is no flag
 * to attach a file, because an agent asked to be helpful would use it.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { confirm, isCancel } from '@clack/prompts';
import {
  AGENT_FEEDBACK_VERSION,
  FEEDBACK_KINDS,
  FEEDBACK_KIND_DESCRIPTIONS,
  MAX_FEEDBACK_DETAIL_LENGTH,
  MAX_FEEDBACK_SUMMARY_LENGTH,
  agentFeedbackReceiptSchema,
  agentFeedbackSchema,
  feedbackKindSchema,
  type AgentFeedback,
  type FeedbackKind,
} from '@ablo/product-analytics/feedback';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { redactObservationString } from '@abloatai/transaction/errorObservation';
import { cliArchitecture, cliOs, cliVersion, nodeMajorVersion } from './cliEnvironment';
import { requestControlPlane } from './controlPlane';
import { resolveManagementKey } from './config';
import { brand } from './theme';

/** The kind column, padded to one width so both blocks below line up. */
const KIND_WIDTH = Math.max(...FEEDBACK_KINDS.map((kind) => kind.length));

const USAGE_LINES = FEEDBACK_KINDS.map(
  (kind) => `    npx ablo feedback ${kind.padEnd(KIND_WIDTH)} "<one line>"  [--detail <text>]`
).join('\n');

const KIND_LINES = FEEDBACK_KINDS.map(
  (kind) => `    ${kind.padEnd(KIND_WIDTH + 2)}${FEEDBACK_KIND_DESCRIPTIONS[kind]}`
).join('\n');

export const FEEDBACK_USAGE = `  ablo feedback — tell us what got in your way

  Usage
${USAGE_LINES}

  Kinds
${KIND_LINES}

  Options
    --detail <text>       What happened, at length. Use \`-\` to read stdin.
    --command <name>      The command in play, e.g. \`push\`.
    --error-code <code>   The code the failure printed, e.g. \`schema_unknown_model\`.
    --from <agent>        Who is reporting, e.g. \`claude-code\`. Detected when omitted.
    --yes                 Send without the confirmation step (agents/CI).
    --json                Print the receipt as JSON.

  Connection strings, API keys, and addresses are removed from what you write
  before it is sent, and on a terminal you see the redacted text first. Nothing
  is read from your repository. Reports are grouped by what they describe, so
  the receipt tells you how many others have hit the same thing.`;

export interface FeedbackArgs {
  kind: FeedbackKind;
  summary: string;
  detail?: string;
  command?: string;
  errorCode?: string;
  from?: string;
  yes: boolean;
  json: boolean;
}

/** Parse separately from execution so a malformed report fails before any
 *  network request, and before a terminal is asked to approve anything. */
export function parseFeedbackArgs(argv: readonly string[]): FeedbackArgs {
  const kindRaw = argv[0];
  const kind = feedbackKindSchema.safeParse(kindRaw);
  if (!kind.success) {
    throw new AbloValidationError(
      `\`ablo feedback\` needs a kind first: ${FEEDBACK_KINDS.join(', ')}.`,
      { code: 'cli_invalid_arguments' }
    );
  }

  const positional: string[] = [];
  let detail: string | undefined;
  let command: string | undefined;
  let errorCode: string | undefined;
  let from: string | undefined;
  let yes = false;
  let json = false;

  const flagValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) {
      throw new AbloValidationError(`\`${flag}\` needs a value.`, {
        code: 'cli_invalid_arguments',
      });
    }
    return value;
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--detail':
        detail = flagValue('--detail', argv[++i]);
        break;
      case '--command':
        command = flagValue('--command', argv[++i]);
        break;
      case '--error-code':
        errorCode = flagValue('--error-code', argv[++i]);
        break;
      case '--from':
        from = flagValue('--from', argv[++i]);
        break;
      case '--yes':
        yes = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        if (arg !== undefined && arg.startsWith('--')) {
          throw new AbloValidationError(`\`${arg}\` is not an option of this command.`, {
            code: 'cli_invalid_arguments',
          });
        }
        if (arg !== undefined) positional.push(arg);
    }
  }

  // Several bare words means the summary was written without quotes. Joining
  // them is what the reporter meant, and refusing would lose the report over
  // shell syntax.
  const summary = positional.join(' ').trim();
  if (!summary) {
    throw new AbloValidationError(
      'Say in one line what got in your way, in quotes after the kind.',
      { code: 'cli_invalid_arguments' }
    );
  }
  if (summary.length > MAX_FEEDBACK_SUMMARY_LENGTH) {
    throw new AbloValidationError(
      `Keep the first line under ${MAX_FEEDBACK_SUMMARY_LENGTH} characters and put the rest in \`--detail\`.`,
      { code: 'cli_invalid_arguments' }
    );
  }

  return {
    kind: kind.data,
    summary,
    ...(detail !== undefined ? { detail } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(from !== undefined ? { from } : {}),
    yes,
    json,
  };
}

export async function feedback(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(FEEDBACK_USAGE);
    return;
  }

  const args = parseFeedbackArgs(argv);
  const detail = args.detail === '-' ? readStdin() : args.detail;
  if (detail !== undefined && detail.length > MAX_FEEDBACK_DETAIL_LENGTH) {
    throw new AbloValidationError(
      `\`--detail\` holds up to ${MAX_FEEDBACK_DETAIL_LENGTH} characters.`,
      { code: 'cli_invalid_arguments' }
    );
  }

  const reporter = reportedBy(args.from);

  // Redact before the preview, so what a reporter approves is what travels.
  // The server redacts again; this pass exists to make the promise visible.
  const report: AgentFeedback = agentFeedbackSchema.parse({
    feedbackVersion: AGENT_FEEDBACK_VERSION,
    submissionId: randomUUID(),
    occurredAt: new Date().toISOString(),
    kind: args.kind,
    summary: redactObservationString(args.summary),
    ...(detail ? { detail: redactObservationString(detail) } : {}),
    context: {
      ...(args.command !== undefined ? { command: args.command } : {}),
      ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      ...(reporter !== undefined ? { reportedBy: reporter } : {}),
      cliVersion: cliVersion(),
      os: cliOs(),
      architecture: cliArchitecture(),
      nodeMajorVersion: nodeMajorVersion(),
    },
  });

  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY) && !args.yes;
  if (interactive) {
    printPreview(report);
    const proceed = await confirm({ message: 'Send this?' });
    if (isCancel(proceed) || !proceed) {
      console.log(`  ${pc.dim('Nothing sent.')}`);
      return;
    }
  }

  // Sent when a login is already stored, so the report can be attributed and
  // triaged ahead of anonymous ones. Its absence is never a reason to fail: the
  // agent stuck before it has a key is the one worth hearing from.
  const managementKey = resolveManagementKey();

  const receipt = await requestControlPlane({
    path: '/v1/feedback',
    method: 'POST',
    body: { feedback: report },
    ...(managementKey !== undefined ? { apiKey: managementKey } : {}),
    responseSchema: agentFeedbackReceiptSchema,
    timeoutMs: 10_000,
  });

  if (args.json || process.env.ABLO_JSON === '1') {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  if (receipt.duplicate) {
    console.log(`  ${pc.dim('Already recorded — this report was sent before.')}`);
    return;
  }
  console.log(`  ${pc.green('✓')} Thank you. Recorded as ${pc.dim(receipt.submissionId)}`);
  if (receipt.clusterCount > 1) {
    console.log(
      `    ${pc.dim(`${receipt.clusterCount} reports describe this same thing.`)}`
    );
  }
}

function printPreview(report: AgentFeedback): void {
  console.log(`\n  ${brand('ablo')} ${pc.dim('feedback')} ${pc.dim(report.kind)}\n`);
  console.log(`  ${report.summary}`);
  if (report.detail) {
    console.log();
    for (const line of report.detail.split('\n')) console.log(`  ${pc.dim(line)}`);
  }
  const context = [
    report.context.command ? `command ${report.context.command}` : null,
    report.context.errorCode ? `code ${report.context.errorCode}` : null,
    report.context.reportedBy ? `from ${report.context.reportedBy}` : null,
    report.context.cliVersion ? `cli ${report.context.cliVersion}` : null,
    report.context.os ?? null,
  ].filter((entry): entry is string => entry !== null);
  console.log(`\n  ${pc.dim(context.join(' · '))}\n`);
}

/**
 * Who is reporting. Detection is deliberately narrow: a wrong guess mislabels
 * the corpus in a way nobody notices, which is worse than an unlabelled report.
 * `--from` and `ABLO_AGENT` are the paths that always work, and any harness can
 * set the latter once for every command it runs.
 */
function reportedBy(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const configured = process.env.ABLO_AGENT?.trim();
  if (configured) return configured;
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  return undefined;
}

/** Descriptor 0 is the portable read of already-piped input. A terminal with
 *  nothing piped would block forever, so that case is refused up front. */
function readStdin(): string {
  if (process.stdin.isTTY) {
    throw new AbloValidationError(
      '`--detail -` reads piped input. Pass the text directly instead.',
      { code: 'cli_invalid_arguments' }
    );
  }
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    throw new AbloValidationError('Could not read `--detail` from stdin.', {
      code: 'cli_invalid_arguments',
    });
  }
}
