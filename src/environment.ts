import { z } from 'zod';

export const ENVIRONMENTS = ['production', 'sandbox'] as const;

export type KeyPrefixEnvironment = 'live' | 'test';

export const environmentSchema = z.enum(ENVIRONMENTS);

export type Environment = z.infer<typeof environmentSchema>;

export function normalizeEnvironment(value: unknown, fallback: Environment = 'production'): Environment {
  const parsed = environmentSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function environmentFromKeyPrefix(value: KeyPrefixEnvironment): Environment {
  return value === 'test' ? 'sandbox' : 'production';
}

export function environmentToKeyPrefix(value: Environment): KeyPrefixEnvironment {
  return value === 'sandbox' ? 'test' : 'live';
}

export function isSandboxEnvironment(value: Environment): boolean {
  return value === 'sandbox';
}
