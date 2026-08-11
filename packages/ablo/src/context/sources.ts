import { z } from 'zod';
import type { ContextEvidenceSlice } from './evidence.js';

export const contextSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    key: z.string(),
    kind: z.literal('ablo'),
    guarantee: z.literal('guardable'),
    cursor: z.number().int().nonnegative(),
  }),
  z.object({
    key: z.string(),
    kind: z.literal('value'),
    guarantee: z.literal('informational'),
    cursor: z.null(),
  }),
  z.object({
    key: z.string(),
    kind: z.literal('mixed'),
    guarantee: z.literal('partial'),
    cursor: z.number().int().nonnegative(),
  }),
]).readonly();

export type ContextSource = z.infer<typeof contextSourceSchema>;

export function sourceFor(
  key: string,
  evidence: ContextEvidenceSlice,
): ContextSource {
  if (evidence.reads.length === 0) {
    return contextSourceSchema.parse({
      key,
      kind: 'value',
      guarantee: 'informational',
      cursor: null,
    });
  }
  const cursor = Math.max(...evidence.reads.map((item) => item.entry.watermark));
  return evidence.includesInformational
    ? contextSourceSchema.parse({ key, kind: 'mixed', guarantee: 'partial', cursor })
    : contextSourceSchema.parse({ key, kind: 'ablo', guarantee: 'guardable', cursor });
}
