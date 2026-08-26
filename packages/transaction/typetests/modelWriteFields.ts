import type {
  ModelDeleteParams,
  ModelUpdateParams,
} from '../src/client/resources/modelOperations.js';

interface ItemRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  status: 'todo' | 'done';
  displayTitle: string;
  getModelName(): string;
}

interface ItemInput {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
  title: string;
  status?: 'todo' | 'done';
}

export const validUpdate: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  data: { title: 'Done', status: 'done' },
  claim: { fields: (item) => item.title },
};

export const modelWritesHaveOneConfirmationContract: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  data: { title: 'Done' },
  // @ts-expect-error — awaiting a model write always means authoritative confirmation.
  wait: 'confirmed',
};

export const computedIsNotWritable: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  // @ts-expect-error — computed row values are not in the Zod input shape.
  data: { displayTitle: 'not stored' },
};

export const applicationTimestampIsWritable: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  data: { createdAt: new Date() },
};

export const invalidUpdateClaim: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  data: { title: 'Done' },
  claim: {
    // @ts-expect-error — claims select only the model's Zod-declared fields.
    fields: (item) => item.displayTitle,
  },
};

export const validDeleteClaim: ModelDeleteParams<ItemRow, ItemInput> = {
  id: 't_1',
  claim: { fields: (item) => item.status },
};

export const timestampClaim: ModelDeleteParams<ItemRow, ItemInput> = {
  id: 't_1',
  claim: {
    fields: (item) => item.createdAt,
  },
};

/**
 * Clearing a field is expressible without a cast.
 *
 * The double-cast integrations were writing to unassign an issue was not a
 * style problem: `null` was genuinely not assignable, so the only spelling
 * that both compiled and worked was one that turned checking off for the whole
 * patch. These pin that the type now says what the wire has always accepted.
 */
export const optionalFieldClearsWithNull: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  data: { status: null },
};

export const requiredFieldStillCannotBeCleared: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  // @ts-expect-error — `title` is required by the model, so there is no clear.
  data: { title: null },
};

export const omittingAFieldIsStillHowYouLeaveIt: ModelUpdateParams<ItemRow, ItemInput> = {
  id: 't_1',
  data: {},
};

/**
 * A delete names the row by `id`.
 *
 * `{ where: { id } }` reads like it should work, matches the shape the commit
 * protocol uses one layer down, and was reported deleting nothing. Pin that
 * the typed surface refuses it rather than accepting it and doing nothing.
 */
export const deleteByWhereIsRefused: ModelDeleteParams<ItemRow, ItemInput> = {
  // @ts-expect-error — a delete names the row by `id`, not by a filter.
  where: { id: 't_1' },
};
