import { describe, expect, it } from '@jest/globals';
import {
  capabilityCanSchemaFor,
  capabilityOperationSchema,
} from '../capability';

const canSchema = capabilityCanSchemaFor({
  items: { typename: 'Item' },
  workspaces: { typename: 'Workspace' },
});

describe('schema-bound capability contract', () => {
  it('accepts non-empty grants over declared schema models', () => {
    expect(
      canSchema.parse({
        items: ['update'],
        workspaces: ['read'],
      }),
    ).toEqual({
      items: ['update'],
      workspaces: ['read'],
    });
  });

  it('rejects unknown models, empty operations, and empty grants', () => {
    expect(() => canSchema.parse({ documents: ['read'] })).toThrow(
      /not declared by this schema/,
    );
    expect(() => canSchema.parse({ items: [] })).toThrow();
    expect(() => canSchema.parse({})).toThrow(/at least one operation/);
  });

  it('uses the canonical operation Zod enum', () => {
    expect(capabilityOperationSchema.options).toEqual([
      'read',
      'create',
      'update',
      'delete',
    ]);
    expect(() => canSchema.parse({ items: ['write'] })).toThrow();
  });
});
