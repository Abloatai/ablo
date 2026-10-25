import { z } from 'zod';
import { operationSchemas } from '../operations/contract.js';

/** @internal The operation journal must never become an application model. */
export const TEXT_HISTORY_TABLE = 'sync_text_fields';

// Plain text only. Positions count Unicode code points, not UTF-16 code units.
export const textValueSchema = z.string().max(1_000_000).refine(
  (value) => !/[\uD800-\uDFFF]/u.test(value),
  'Text must not contain unpaired surrogates',
);

const countSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonemptyTextSchema = textValueSchema.refine((value) => value.length > 0);
export const textOperationSchema = z.array(z.union([
  countSchema,
  nonemptyTextSchema,
  z.strictObject({ d: z.union([countSchema, nonemptyTextSchema]) }),
])).max(4096);
export type TextOperation = z.infer<typeof textOperationSchema>;

const schemas = operationSchemas(textValueSchema, textOperationSchema);
export const textSnapshotSchema = schemas.snapshot;
export const textEditSchema = schemas.edit;
export const acceptedTextEditSchema = schemas.accepted;
export const textHistorySchema = schemas.history;
export const textSessionStateSchema = schemas.state;
export type TextSnapshot = z.infer<typeof textSnapshotSchema>;
export type TextEdit = z.infer<typeof textEditSchema>;
export type AcceptedTextEdit = z.infer<typeof acceptedTextEditSchema>;
export type TextHistory = z.infer<typeof textHistorySchema>;
export type TextSessionState = z.infer<typeof textSessionStateSchema>;

export const textEditValueSchema = z.strictObject({ $text: textEditSchema });
export function isTextEditValue(value: unknown): value is { $text: unknown } {
  return typeof value === 'object' && value !== null && '$text' in value;
}
