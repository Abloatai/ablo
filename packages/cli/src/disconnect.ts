/**
 * `ablo connect deregister` — remove the active project's data-source registration so
 * Ablo stops reading and writing that database. Scoped to the project and branch
 * persisted on the key, resolved and shown before the destructive call so the
 * production root is never disconnected by surprise. A key can only disconnect
 * its own branch. The
 * database is untouched; the registration and Ablo's replication state go away —
 * with one exception the server reports and this command must repeat: a
 * replication slot it could not release stays on the database, holding
 * write-ahead log, until the operator removes it with the statement provided.
 *
 * `DELETE /v1/datasources`, authed by the project's secret key.
 */

import pc from 'picocolors';
import { confirm, isCancel } from '@clack/prompts';

import {
  AbloAuthenticationError,
  AbloError,
  AbloPermissionError,
  AbloValidationError,
} from '@abloatai/transaction/errors';
import {
  datasourceDisconnectedResponseSchema,
  type DatasourceDisconnectedResponse,
} from '@abloatai/transaction/wire';
import { resolveMutationApiKey, type ResolvedKeySource } from './config';
import { readProjectEnvVariable } from './dbRole';
import { apiBaseUrl, requestControlPlane, type ControlPlaneFetch } from './controlPlane';
import { brand } from './theme';
import { resolveTarget, describeMismatches, type ResolvedTarget } from './target';

/** The (project, branch) plane a disconnect will act on, for display. */
function planeLabel(target: ResolvedTarget): { project: string; branch: string } {
  const confirmed = target.confirmed;
  const project =
    confirmed?.project?.name ??
    confirmed?.project?.slug ??
    confirmed?.projectId ??
    'the default project';
  const branch =
    confirmed?.branchRoot === true
      ? 'production root'
      : confirmed?.branchId
        ? `branch ${confirmed.branchId}`
        : target.keyEnv === 'production'
          ? 'production root (legacy key; unconfirmed)'
          : target.keyEnv === 'sandbox'
            ? 'development branch (legacy key; unconfirmed)'
            : 'unknown branch';
  return { project, branch };
}

/** What a deregistration did, typed for rendering and for tests. */
export type DisconnectOutcome =
  | { readonly removed: true; readonly response: DatasourceDisconnectedResponse }
  /** Nothing was registered on this plane — a no-op, not a failure. */
  | { readonly removed: false };

/**
 * The operation itself, free of prompts and rendering: one DELETE through the
 * control-plane boundary, parsed against the wire schema. "Nothing registered"
 * resolves rather than throws, because the caller's goal — this plane has no
 * data source — already holds. A permission refusal is re-raised with the
 * remedy attached: the generic scope hint cannot know it is the key KIND
 * (`sk_…`) that disconnecting requires.
 */
export async function deregisterDataSource(opts: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: ControlPlaneFetch;
}): Promise<DisconnectOutcome> {
  try {
    const response = await requestControlPlane({
      path: '/v1/datasources',
      method: 'DELETE',
      apiKey: opts.apiKey,
      responseSchema: datasourceDisconnectedResponseSchema,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    return { removed: true, response };
  } catch (err) {
    if (err instanceof AbloError && err.code === 'entity_not_found') return { removed: false };
    if (err instanceof AbloError && err.code === 'forbidden') {
      throw new AbloPermissionError(
        `${err.message}. Disconnecting needs a branch-bound secret key (sk_…).`,
        {
          code: 'forbidden',
          ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
        }
      );
    }
    throw err;
  }
}

/** The success lines, from the parsed response — including the slot warning
 *  the server attaches when it stopped reading but could not release the slot. */
function renderDisconnected(
  response: DatasourceDisconnectedResponse,
  project: string,
  branchLabel: string
): void {
  const parts: string[] = [];
  if (response.cleared.direct) parts.push('the direct database registration');
  if (response.cleared.endpoints > 0) {
    parts.push(
      `${response.cleared.endpoints} endpoint registration${response.cleared.endpoints === 1 ? '' : 's'}`
    );
  }
  const what = parts.length > 0 ? parts.join(' and ') : 'the data source';
  console.log(
    `\n  ${pc.green('✓')} Disconnected ${what} for ${pc.bold(project)} on ${branchLabel}. Reconnect with ${pc.bold('ablo connect')}.\n`
  );
  const slot = response.replication_slot;
  if (slot && !slot.released) {
    // The one thing that outlives a disconnect. Ablo has stopped reading, so
    // nothing will ever release this slot now — left unrendered it silently
    // holds the customer's write-ahead log until the disk fills.
    console.log(
      `  ${pc.yellow('!')} ${
        slot.warning ??
        `The replication slot ${pc.bold(slot.slot)} is still on your database and still holding your write-ahead log. Remove it yourself — nothing will release it now.`
      }`
    );
    if (slot.detail) console.log(pc.dim(`      ${slot.detail}`));
    console.log(
      pc.dim(
        `      Moving this database to another branch? Keep the roles and slot; run ` +
          `${pc.bold('ablo connect rotate --env-file .env.local --yes')} to re-key and reuse them.`,
      ),
    );
    if (slot.remove_with) {
      console.log(pc.dim('      Not reconnecting this database? Remove the unused slot in your SQL editor:'));
      console.log(`      ${pc.bold(slot.remove_with)}`);
    }
    console.log();
  }
}

export async function disconnect(argv: readonly string[]): Promise<void> {
  let skipConfirm = false;
  let envFile: string | undefined;
  let keyEnv: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') skipConfirm = true;
    else if (arg === '--env-file') envFile = argv[++i];
    else if (arg === '--key-env') keyEnv = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(DISCONNECT_USAGE);
      return;
    } else {
      throw new AbloValidationError(
        `unknown flag: ${arg} — see \`ablo connect deregister --help\``,
        { code: 'cli_invalid_arguments' }
      );
    }
  }

  console.log(
    `\n  ${brand('ablo')} ${pc.dim('connect deregister')}  ${pc.dim("remove this project's data source")}\n`
  );

  if (envFile) {
    try {
      process.loadEnvFile(envFile);
    } catch (error) {
      throw new AbloValidationError(
        `could not load --env-file ${envFile}: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'cli_invalid_arguments' },
      );
    }
  }
  const selected = keyEnv ? readProjectEnvVariable(keyEnv) : null;
  if (keyEnv && !selected) {
    throw new AbloAuthenticationError(
      `No value named ${keyEnv} was found in the process environment, .env.local, or .env.`,
      { code: 'cli_api_key_missing' },
    );
  }
  const resolved = selected
    ? { key: selected.value, source: selected.source }
    : {
        key: resolveMutationApiKey(),
        source: envFile
          ? ('explicit-file' as const)
          : process.env.ABLO_API_KEY
            ? ('env' as const)
            : ('stored' as const),
      };
  const apiKey = resolved.key;
  const keySource: ResolvedKeySource = resolved.source ?? 'stored';
  if (!apiKey) {
    throw new AbloAuthenticationError(
      'Disconnecting needs a branch-bound sk_ key. Set ABLO_API_KEY, pass `--env-file .env.local`, or select a named recovery key with `--key-env <NAME>`.',
      { code: 'cli_api_key_missing' }
    );
  }

  const apiUrl = apiBaseUrl();

  // Resolve the exact plane this key acts on (project + environment), reconciled
  // against the local `ablo projects use` selection — the same
  // resolution `ablo push` shows, so the banner can't say one plane while the
  // disconnect hits another.
  const target = await resolveTarget({ url: apiUrl, apiKey, keySource });
  const { project, branch } = planeLabel(target);
  const branchLabel = target.confirmed?.branchRoot ? pc.yellow(branch) : pc.dim(branch);

  // Surface a saved-selection divergence before the call, not after — this is
  // the moment to catch acting on the wrong plane.
  const divergence = describeMismatches(target.mismatches);
  if (divergence) console.log(`  ${pc.yellow('⚠')}  ${divergence}\n`);

  if (!skipConfirm) {
    if (!process.stdout.isTTY) {
      throw new AbloValidationError(
        'This session has no terminal to confirm in. Re-run with --yes to disconnect non-interactively.',
        { code: 'cli_invalid_arguments' }
      );
    }
    const proceed = await confirm({
      message: `Disconnect the data source for ${pc.bold(project)} on ${branchLabel}?`,
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      console.log(pc.dim(`  Nothing changed. The data source is still connected.\n`));
      return;
    }
  }

  const outcome = await deregisterDataSource({ apiKey });
  if (!outcome.removed) {
    console.log(pc.dim(`  No data source registered for ${project} on ${branch}.\n`));
    return;
  }
  renderDisconnected(outcome.response, project, branchLabel);
}

export const DISCONNECT_USAGE = `${brand('ablo')} connect deregister  ${pc.dim("remove this project's data source")}

  Usage
    npx ablo connect deregister          Remove the active project's data source (confirms first)
    npx ablo connect deregister --yes    Skip the confirmation
    npx ablo connect deregister --key-env OLD_KEY_NAME --yes

  Acts on exactly the server-confirmed project and branch bound to the key, shown
  before it runs. Removes the registration and
  Ablo's replication state for that plane, so Ablo stops reading and writing the
  database. Reconnect with ${pc.bold('ablo connect')}.`;
