/**
 * `ablo whoami` — the small, strict answer to "what does this key act on?"
 *
 * `status` is the broad health report and deliberately degrades when an older
 * or unreachable server cannot confirm identity. That is the wrong contract
 * for this command: an explicit identity question either returns the
 * server-confirmed plane or fails. This makes it safe to use before a connect
 * or deregister instead of inferring key scope from a failed mutation.
 */

import pc from 'picocolors';
import {
  AbloAuthenticationError,
  AbloValidationError,
} from '@abloatai/transaction/errors';
import {
  ambientEnvKeyNote,
  resolveRuntimeApiKey,
  resolveManagementKey,
  type ResolvedKeySource,
} from './config';
import { apiBaseUrl } from './controlPlane';
import { credentialCapability } from './credentialCapability';
import { readProjectEnvVariable } from './dbRole';
import { brand } from './theme';
import { resolveTarget } from './target';

export const WHOAMI_USAGE = `  ablo whoami — show the plane a credential acts on

  Usage
    npx ablo whoami
    npx ablo whoami --key-env <NAME>
    npx ablo whoami --key <VALUE>
    npx ablo whoami --json

  Credential choice
    With no flag, uses ABLO_API_KEY, then the active project's stored data key,
    then the stored login. This command does not load .env files implicitly.

    --key-env reads a named variable from the process, .env.local, or .env
    without putting its value in shell history or the process list. Prefer it
    for comparing several keys.
    --key accepts a value directly for one-off use.

  Output never prints the full credential. Identity is confirmed by the server;
  an invalid key, unreachable server, or unsupported server fails non-zero.`;

export interface WhoamiArgs {
  json: boolean;
  key?: string;
  keyEnv?: string;
}

/** Parse separately from execution so malformed credential selection fails
 * before any network request. */
export function parseWhoamiArgs(argv: readonly string[]): WhoamiArgs {
  let json = false;
  let key: string | undefined;
  let keyEnv: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--key': {
        const value = argv[++i];
        if (!value || value.startsWith('--')) {
          throw new AbloValidationError('`--key` needs a credential value.', {
            code: 'cli_invalid_arguments',
          });
        }
        key = value;
        break;
      }
      case '--key-env': {
        const value = argv[++i];
        if (!value || value.startsWith('--')) {
          throw new AbloValidationError('`--key-env` needs an environment variable name.', {
            code: 'cli_invalid_arguments',
          });
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
          throw new AbloValidationError(
            `\`${value}\` is not a valid environment variable name.`,
            { code: 'cli_invalid_arguments' },
          );
        }
        keyEnv = value;
        break;
      }
      default:
        throw new AbloValidationError(`unknown whoami flag: ${arg}`, {
          code: 'cli_invalid_arguments',
        });
    }
  }

  if (key && keyEnv) {
    throw new AbloValidationError('Choose one credential source: `--key` or `--key-env`.', {
      code: 'cli_invalid_arguments',
    });
  }
  return { json, ...(key ? { key } : {}), ...(keyEnv ? { keyEnv } : {}) };
}

interface SelectedCredential {
  key: string;
  source: string;
  targetSource: ResolvedKeySource;
}

/** Resolve only explicit process state and stored credentials. An env file
 * never silently chooses the subject of an identity check. */
export function selectWhoamiCredential(
  args: WhoamiArgs,
  cwd: string = process.cwd(),
): SelectedCredential {
  if (args.key) return { key: args.key, source: '--key', targetSource: 'env' };

  if (args.keyEnv) {
    const found = readProjectEnvVariable(args.keyEnv, cwd);
    if (!found) {
      throw new AbloAuthenticationError(
        `${args.keyEnv} is not set in the process environment, .env.local, or .env.`,
        { code: 'cli_api_key_missing' },
      );
    }
    return {
      key: found.value,
      source: `${found.source}:${args.keyEnv}`,
      targetSource: 'env',
    };
  }

  const runtimeKey = resolveRuntimeApiKey();
  const dataKey = runtimeKey.key;
  if (dataKey) {
    return {
      key: dataKey,
      source:
        runtimeKey.source === 'stored'
          ? 'stored data key'
          : `${runtimeKey.source ?? 'env'}:ABLO_API_KEY`,
      targetSource: runtimeKey.source ?? 'stored',
    };
  }

  const managementKey = resolveManagementKey();
  if (managementKey) {
    return {
      key: managementKey,
      source: 'stored login',
      targetSource: 'stored',
    };
  }

  const ambient = ambientEnvKeyNote();
  throw new AbloAuthenticationError(
    `No credential found. Run \`ablo login\`, set ABLO_API_KEY, or pass \`--key-env <NAME>\`.${ambient ? `\n\n${ambient}` : ''}`,
    { code: 'cli_api_key_missing' },
  );
}

export async function whoami(argv: readonly string[]): Promise<void> {
  const args = parseWhoamiArgs(argv);
  const selected = selectWhoamiCredential(args);
  const target = await resolveTarget({
    url: apiBaseUrl(),
    apiKey: selected.key,
    keySource: selected.targetSource,
    strict: true,
  });
  const confirmed = target.confirmed;
  if (!confirmed) {
    // `strict` makes this unreachable, but keeping the boundary explicit means
    // a future resolver change cannot turn "who am I?" into a local guess.
    throw new AbloAuthenticationError(
      'The server did not confirm an identity for this credential.',
      { code: 'identity_resolve_failed' },
    );
  }

  const project = confirmed.project;
  const projectLabel = project
    ? project.isDefault
      ? 'default'
      : project.slug
    : 'default';
  const actsOn = confirmed.branchId
    ? confirmed.branchRoot
      ? 'production root'
      : `branch ${confirmed.branchId}`
    : confirmed.environment ?? 'unknown';
  const capability = credentialCapability(selected.key);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          authenticated: true,
          key: {
            prefix: `${selected.key.slice(0, 12)}…`,
            source: selected.source,
            kind: capability.kind,
          },
          organizationId: confirmed.organizationId,
          project: project
            ? {
                id: project.id,
                slug: projectLabel,
                name: project.name,
                default: project.isDefault,
              }
            : null,
          environment: confirmed.environment,
          branchId: confirmed.branchId ?? null,
          branchRoot: confirmed.branchRoot ?? false,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('whoami')}\n`);
  console.log(
    `  ${pc.dim('key')}     ${selected.key.slice(0, 12)}… ${pc.dim(`(${selected.source} · ${capability.label})`)}`,
  );
  console.log(`  ${pc.dim('org')}     ${pc.dim(confirmed.organizationId)}`);
  console.log(
    `  ${pc.dim('project')} ${pc.bold(projectLabel)}${
      project ? ` ${pc.dim(`(${project.id})`)}` : ''
    }`,
  );
  console.log(`  ${pc.dim('acts on')} ${pc.bold(actsOn)}`);
  console.log(`\n  ${pc.green('✓')} ${pc.dim('credential accepted; target confirmed by the server')}\n`);
}
