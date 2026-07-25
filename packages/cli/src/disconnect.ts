/**
 * `ablo connect deregister` — remove the active project's data-source registration so
 * Ablo stops reading and writing that database. Scoped to one plane: the active
 * project (`ablo projects use`) in the active environment (`ablo mode` + the
 * key's prefix), resolved and shown before the destructive call so a production
 * plane is never disconnected by surprise. The server derives the plane from the
 * key, so a key can only disconnect its own org/project/environment/sandbox. The
 * database is untouched; the registration and Ablo's replication state go away.
 *
 * `DELETE /api/v1/datasources`, authed by the project's secret key.
 */

import pc from 'picocolors';
import { confirm, isCancel } from '@clack/prompts';

import { resolveEffectiveApiKey, type EffectiveKeySource } from './config';
import { apiBaseUrl } from './push';
import { brand } from './theme';
import { registerEndpoint } from './connectSetup';
import { resolveTarget, describeMismatches, type ResolvedTarget } from './target';

/** The (project, environment) plane a disconnect will act on, for display. */
function planeLabel(target: ResolvedTarget): { project: string; env: string } {
  const confirmed = target.confirmed;
  const project =
    confirmed?.project?.name ??
    confirmed?.project?.slug ??
    confirmed?.projectId ??
    'the default project';
  const env = confirmed?.environment ?? target.keyEnv ?? 'unknown environment';
  return { project, env };
}

export async function disconnect(argv: readonly string[]): Promise<void> {
  let skipConfirm = false;
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') skipConfirm = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(DISCONNECT_USAGE);
      return;
    } else {
      console.error(
        pc.red(`  Unknown flag ${pc.bold(arg)}.`) +
          pc.dim(` See ${pc.bold('ablo connect deregister --help')}.`)
      );
      process.exit(1);
    }
  }

  console.log(
    `\n  ${brand('ablo')} ${pc.dim('connect deregister')}  ${pc.dim("remove this project's data source")}\n`
  );

  const resolved = resolveEffectiveApiKey();
  const apiKey = resolved.key;
  const keySource: EffectiveKeySource = resolved.source ?? 'stored';
  if (!apiKey) {
    console.error(
      pc.red(`  Disconnecting needs an API key, and none was found.`) +
        pc.dim(
          ` Run ${pc.bold('ablo login')} (or set ${pc.bold('ABLO_API_KEY')}), then re-run ${pc.bold('ablo connect deregister')}.`
        )
    );
    process.exit(1);
  }

  const apiUrl = apiBaseUrl();

  // Resolve the exact plane this key acts on (project + environment), reconciled
  // against the local `ablo projects use` / `ablo mode` preferences — the same
  // resolution `ablo push` shows, so the banner can't say one plane while the
  // disconnect hits another.
  const target = await resolveTarget({ url: apiUrl, apiKey, keySource });
  const { project, env } = planeLabel(target);
  const envLabel = env === 'production' ? pc.yellow(env) : pc.dim(env);

  // Surface a saved-selection divergence before the call, not after — this is
  // the moment to catch acting on the wrong plane.
  const divergence = describeMismatches(target.mismatches);
  if (divergence) console.log(`  ${pc.yellow('⚠')}  ${divergence}\n`);

  if (!skipConfirm) {
    if (!process.stdout.isTTY) {
      console.error(
        pc.dim(`  Re-run with ${pc.bold('--yes')} to disconnect in a non-interactive session.\n`)
      );
      process.exit(1);
    }
    const proceed = await confirm({
      message: `Disconnect the data source for ${pc.bold(project)} in ${envLabel}?`,
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      console.log(pc.dim(`  Nothing changed. The data source is still connected.\n`));
      process.exit(0);
    }
  }

  let res: Response;
  try {
    res = await fetch(registerEndpoint(apiUrl), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.error(
      pc.red(`\n  Couldn't reach ${apiUrl}: ${err instanceof Error ? err.message : String(err)}\n`)
    );
    process.exit(1);
  }

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      cleared?: { direct?: boolean; endpoints?: number };
    };
    const parts: string[] = [];
    if (body.cleared?.direct) parts.push('the direct database registration');
    if (body.cleared?.endpoints) {
      parts.push(
        `${body.cleared.endpoints} endpoint registration${body.cleared.endpoints === 1 ? '' : 's'}`
      );
    }
    const what = parts.length > 0 ? parts.join(' and ') : 'the data source';
    console.log(
      `\n  ${pc.green('✓')} Disconnected ${what} for ${pc.bold(project)} in ${envLabel}. Reconnect with ${pc.bold('ablo connect')}.\n`
    );
    return;
  }

  // Flat error envelope: `{ code, message }` (nested `error.code` kept for
  // older/wrapped deployments).
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    error?: { code?: string; message?: string };
  };
  const code = body.code ?? body.error?.code;
  const message = body.message ?? body.error?.message ?? `HTTP ${res.status}`;

  // Not connected — a no-op the caller usually wants to hear as success.
  if (code === 'entity_not_found') {
    console.log(pc.dim(`  No data source registered for ${project} in ${env}.\n`));
    return;
  }

  console.error(pc.red(`\n  Disconnect failed: ${message}`));
  if (code === 'forbidden') {
    console.error(
      pc.dim(
        `  Disconnecting needs a ${pc.bold('secret')} key (sk_…). Run ${pc.bold('ablo login')} for one.`
      )
    );
  }
  console.error();
  process.exit(1);
}

export const DISCONNECT_USAGE = `${brand('ablo')} connect deregister  ${pc.dim("remove this project's data source")}

  Usage
    npx ablo connect deregister          Remove the active project's data source (confirms first)
    npx ablo connect deregister --yes    Skip the confirmation

  Acts on one plane — the active project (${pc.bold('ablo projects use')}) in the active
  environment (${pc.bold('ablo mode')}), shown before it runs. Removes the registration and
  Ablo's replication state for that plane, so Ablo stops reading and writing the
  database. Reconnect with ${pc.bold('ablo connect')}.`;
