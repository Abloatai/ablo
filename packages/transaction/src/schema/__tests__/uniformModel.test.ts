import {
  defineSchema,
  field,
  generateTypes,
  model,
  serializeSchema,
  type InferCreate,
  type Model,
} from '../index.js';

describe('uniform database model', () => {
  const schema = defineSchema({
    taskEvents: model(
      {
        taskId: field.string().from('task_id'),
        createdAt: field.number().from('created_at'),
      },
      { tableName: 'task_events' },
    ),
  });

  it('serializes the application model without a database ownership mode', () => {
    const json = JSON.parse(serializeSchema(schema));
    expect(Object.keys(json.models.taskEvents)).not.toContain('storage');
  });

  it('emits application timestamps exactly as declared', () => {
    const json = JSON.parse(serializeSchema(schema));
    expect(generateTypes(json)).not.toContain('updatedAt');
    expect(generateTypes(json)).toContain('  createdAt: number;');
  });

  it('builds a validator from the application timestamp declaration', () => {
    const row = schema.validators.taskEvents.parse({
      id: '42',
      createdAt: 0,
      taskId: 'task-1',
    });
    expect(row.createdAt).toBe(0);
  });

  it('keeps application field types in rows and create input', () => {
    type TaskEvent = Model<typeof schema, 'taskEvents'>;
    type CreateTaskEvent = InferCreate<typeof schema, 'taskEvents'>;
    const row: Pick<TaskEvent, 'id' | 'createdAt' | 'taskId'> = {
      id: '42',
      createdAt: 0,
      taskId: 'task-1',
    };
    const input: CreateTaskEvent = { taskId: 'task-1', createdAt: 0 };
    expect({ row, input }).toEqual({
      row: { id: '42', createdAt: 0, taskId: 'task-1' },
      input: { taskId: 'task-1', createdAt: 0 },
    });
  });
});
