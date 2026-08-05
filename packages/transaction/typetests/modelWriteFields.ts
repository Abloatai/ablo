import type {
  ModelDeleteParams,
  ModelUpdateParams,
} from '../src/resources/modelOperations.js';

interface TaskRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  status: 'todo' | 'done';
  displayTitle: string;
  getModelName(): string;
}

interface TaskInput {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
  title: string;
  status?: 'todo' | 'done';
}

export const validUpdate: ModelUpdateParams<TaskRow, TaskInput> = {
  id: 't_1',
  data: { title: 'Done', status: 'done' },
  claim: { fields: (task) => task.title },
};

export const modelWritesHaveOneConfirmationContract: ModelUpdateParams<TaskRow, TaskInput> = {
  id: 't_1',
  data: { title: 'Done' },
  // @ts-expect-error — awaiting a model write always means authoritative confirmation.
  wait: 'confirmed',
};

export const computedIsNotWritable: ModelUpdateParams<TaskRow, TaskInput> = {
  id: 't_1',
  // @ts-expect-error — computed row values are not in the Zod input shape.
  data: { displayTitle: 'not stored' },
};

export const frameworkFieldIsNotWritable: ModelUpdateParams<TaskRow, TaskInput> = {
  id: 't_1',
  // @ts-expect-error — framework fields are controlled outside update.data.
  data: { createdAt: new Date() },
};

export const invalidUpdateClaim: ModelUpdateParams<TaskRow, TaskInput> = {
  id: 't_1',
  data: { title: 'Done' },
  claim: {
    // @ts-expect-error — claims select only the model's Zod-declared fields.
    fields: (task) => task.displayTitle,
  },
};

export const validDeleteClaim: ModelDeleteParams<TaskRow, TaskInput> = {
  id: 't_1',
  claim: { fields: (task) => task.status },
};

export const invalidDeleteClaim: ModelDeleteParams<TaskRow, TaskInput> = {
  id: 't_1',
  claim: {
    // @ts-expect-error — delete uses the same schema-derived claim selector.
    fields: (task) => task.createdAt,
  },
};
