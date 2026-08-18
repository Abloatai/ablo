/**
 * What this CLI installation is, as the analytics vocabulary spells it.
 *
 * Version, OS, and architecture are asked for by more than one reporting path —
 * the telemetry counters and `ablo feedback` both stamp them — and each answer
 * is a closed enum that a second hand-written copy would eventually disagree
 * with. `other` exists so an unrecognized platform stays reportable instead of
 * widening the enum at the far end.
 */

import { arch, platform } from 'node:os';
import type { z } from 'zod';
import type { cliArchitectureSchema, cliOsSchema } from '@ablo/product-analytics';

export type CliOs = z.infer<typeof cliOsSchema>;
export type CliArchitecture = z.infer<typeof cliArchitectureSchema>;

/** The published version, or `development` when running from the repository. */
export function cliVersion(): string {
  return process.env.ABLO_CLI_EMBEDDED_VERSION ?? process.env.npm_package_version ?? 'development';
}

export function cliOs(): CliOs {
  const value = platform();
  return value === 'darwin' || value === 'linux' || value === 'win32' ? value : 'other';
}

export function cliArchitecture(): CliArchitecture {
  const value = arch();
  return value === 'arm64' || value === 'x64' || value === 'ia32' ? value : 'other';
}

/** Node's major version, as the event and feedback schemas bound it. */
export function nodeMajorVersion(): number {
  return Number(process.versions.node.split('.')[0]);
}
