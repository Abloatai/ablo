/**
 * Type-level + runtime tests for Zod-based schema inference.
 */

import { z } from 'zod';
import { defineSchema, model, field, relation } from '../index';
import type { InferModel, InferCreate } from '../index';

// ── Define a test schema ──────────────────────────────────────────────────

const schema = defineSchema({
  tasks: model(
    {
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      priority: z.number().default(0),
      projectId: z.string().optional(),
      assigneeId: z.string().optional(),
      dueDate: z.date().optional(),
      isBlocked: z.boolean().default(false),
      metadata: z.object({ tags: z.array(z.string()), source: z.string().optional() }).optional(),
    },
    {
      project: relation.belongsTo('projects', 'projectId'),
      comments: relation.hasMany('comments', 'taskId'),
    }
  ),

  projects: model(
    {
      name: z.string(),
      description: z.string().optional(),
      status: z.enum(['active', 'archived']).default('active'),
    },
    {
      tasks: relation.hasMany('tasks', 'projectId'),
    }
  ),

  comments: model({
    content: z.string(),
    taskId: z.string(),
    authorId: z.string(),
  }),

  users: model({
    name: z.string(),
    email: field.id(), // indexed string
  }),
});

// ── Type inference tests (compile-time) ───────────────────────────────────

type Task = InferModel<typeof schema, 'tasks'>;
type Project = InferModel<typeof schema, 'projects'>;
type Comment = InferModel<typeof schema, 'comments'>;

type CreateTask = InferCreate<typeof schema, 'tasks'>;

// Compile-time assertion helper
type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

// Task has base fields
type _TaskHasId = Expect<Equal<Task['id'], string>>;
type _TaskHasCreatedAt = Expect<Equal<Task['createdAt'], Date>>;

// Task has typed fields
type _TaskHasTitle = Expect<Equal<Task['title'], string>>;
type _TaskHasStatus = Expect<Equal<Task['status'], 'todo' | 'in_progress' | 'done'>>;
type _TaskHasPriority = Expect<Equal<Task['priority'], number>>;
type _TaskHasBlocked = Expect<Equal<Task['isBlocked'], boolean>>;

// Optional fields
type _TaskDescOptional = Expect<Equal<Task['description'], string | undefined>>;
type _TaskProjectIdOptional = Expect<Equal<Task['projectId'], string | undefined>>;
type _TaskDueDateOptional = Expect<Equal<Task['dueDate'], Date | undefined>>;

// JSON field preserves type
type _TaskMetadata = Expect<
  Equal<Task['metadata'], { tags: string[]; source?: string } | undefined>
>;

// Create input — fields with defaults are optional
type _CreateTaskTitleRequired = Expect<Equal<CreateTask['title'], string>>;

// ── Runtime tests ─────────────────────────────────────────────────────────

describe('Zod Schema DSL', () => {
  it('defineSchema returns schema with models', () => {
    expect(schema.models).toBeDefined();
    expect(schema.models.tasks).toBeDefined();
    expect(schema.models.projects).toBeDefined();
    expect(schema.models.comments).toBeDefined();
    expect(schema.models.users).toBeDefined();
  });

  it('model has Zod schema that validates', () => {
    const taskSchema = schema.models.tasks.schema;

    const valid = taskSchema.safeParse({
      title: 'Test task',
      status: 'todo',
      priority: 1,
    });
    expect(valid.success).toBe(true);

    const invalid = taskSchema.safeParse({
      // missing required 'title'
      status: 'todo',
    });
    expect(invalid.success).toBe(false);
  });

  it('defaults are applied by Zod', () => {
    const taskSchema = schema.models.tasks.schema;

    const result = taskSchema.parse({ title: 'Test' });
    expect(result.status).toBe('todo');
    expect(result.priority).toBe(0);
    expect(result.isBlocked).toBe(false);
  });

  it('optional fields accept undefined', () => {
    const taskSchema = schema.models.tasks.schema;

    const result = taskSchema.parse({ title: 'Test' });
    expect(result.description).toBeUndefined();
    expect(result.projectId).toBeUndefined();
    expect(result.dueDate).toBeUndefined();
  });

  it('enum fields reject invalid values', () => {
    const taskSchema = schema.models.tasks.schema;

    const result = taskSchema.safeParse({ title: 'Test', status: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('validators include base fields', () => {
    const fullValidator = schema.validators.tasks;

    const result = fullValidator.safeParse({
      id: '123',
      createdAt: new Date(),
      updatedAt: new Date(),
      title: 'Test',
    });
    expect(result.success).toBe(true);
  });

  it('relations have correct metadata', () => {
    const taskRelations = schema.models.tasks.relations;
    expect(taskRelations.project.type).toBe('belongsTo');
    expect(taskRelations.project.target).toBe('projects');
    expect(taskRelations.project.foreignKey).toBe('projectId');

    expect(taskRelations.comments.type).toBe('hasMany');
    expect(taskRelations.comments.target).toBe('comments');
    expect(taskRelations.comments.foreignKey).toBe('taskId');
  });

  it('foreignKeyColumn defaults to foreignKey when no casing is set', () => {
    // Identity default preserves backward-compat for consumers whose DB
    // columns already match their JS field names (or who handle naming
    // themselves). Client ObjectPool + server SQL compiler can both read
    // `foreignKeyColumn` safely either way.
    const taskRelations = schema.models.tasks.relations;
    expect(taskRelations.project.foreignKeyColumn).toBe('projectId');
    expect(taskRelations.comments.foreignKeyColumn).toBe('taskId');
  });

  it('casing: "snake_case" derives foreignKeyColumn from camelCase foreignKey', () => {
    const snakeSchema = defineSchema({
      messages: model(
        { chatId: z.string(), role: z.string() },
        { parts: relation.hasMany('messageParts', 'messageId') },
      ),
      messageParts: model(
        { messageId: z.string(), order: z.number() },
        { message: relation.belongsTo('messages', 'messageId') },
      ),
    }, { casing: 'snake_case' });

    // JS-facing foreignKey is unchanged — client ObjectPool still reads
    // `model.messageId` via this property, so camelCase must survive.
    expect(snakeSchema.models.messages.relations.parts.foreignKey).toBe('messageId');
    expect(snakeSchema.models.messageParts.relations.message.foreignKey).toBe('messageId');

    // DB-facing foreignKeyColumn is the resolved snake_case form — this
    // is what the sync-server injects directly into SQL.
    expect(snakeSchema.models.messages.relations.parts.foreignKeyColumn).toBe('message_id');
    expect(snakeSchema.models.messageParts.relations.message.foreignKeyColumn).toBe('message_id');
  });

  it('casing as a function lets consumers plug their own convention', () => {
    const upperSchema = defineSchema({
      tasks: model(
        { projectId: z.string() },
        { project: relation.belongsTo('projects', 'projectId') },
      ),
      projects: model({ name: z.string() }),
    }, { casing: (key) => key.toUpperCase() });

    expect(upperSchema.models.tasks.relations.project.foreignKeyColumn).toBe('PROJECTID');
  });

  it('field helpers produce valid Zod schemas', () => {
    expect(field.string().parse('hello')).toBe('hello');
    expect(field.number().parse(42)).toBe(42);
    expect(field.boolean().parse(true)).toBe(true);
    expect(field.date().parse(new Date())).toBeInstanceOf(Date);
    expect(field.enum(['a', 'b']).parse('a')).toBe('a');
  });
});

// ── Computed getter inference ───────────────────────────────────────────

const schemaWithComputed = defineSchema({
  chats: model(
    {
      title: z.string(),
      metadata: z.string(),
      userId: z.string(),
    },
    {},
    {
      typename: 'Chat',
      computed: {
        displayTitle: (self): string => (self.title as string) || 'Untitled',
        metadataObject: (self): Record<string, unknown> => {
          try { return JSON.parse((self.metadata as string) || '{}'); }
          catch { return {}; }
        },
        icon: (self): string => ((self.metadataObject as Record<string, unknown>)?.icon as string) ?? 'message-circle',
        hasAgent: (self): boolean => !!(self.agentId),
      },
    }
  ),
});

type ChatRow = InferModel<typeof schemaWithComputed, 'chats'>;

// Compile-time: Zod fields are typed
type _ChatTitle = Expect<Equal<ChatRow['title'], string>>;
type _ChatMetadata = Expect<Equal<ChatRow['metadata'], string>>;
type _ChatUserId = Expect<Equal<ChatRow['userId'], string>>;

// Compile-time: computed getters have inferred return types
type _ChatDisplayTitle = Expect<Equal<ChatRow['displayTitle'], string>>;
type _ChatIcon = Expect<Equal<ChatRow['icon'], string>>;
type _ChatHasAgent = Expect<Equal<ChatRow['hasAgent'], boolean>>;
type _ChatMetadataObject = Expect<Equal<ChatRow['metadataObject'], Record<string, unknown>>>;

// Compile-time: base fields present
type _ChatId = Expect<Equal<ChatRow['id'], string>>;
type _ChatCreatedAt = Expect<Equal<ChatRow['createdAt'], Date>>;

describe('Computed getter inference', () => {
  it('computed getters are present in InferModel type', () => {
    // Runtime: just verify the schema has computed defined
    expect(schemaWithComputed.models.chats.computed).toBeDefined();
    expect(schemaWithComputed.models.chats.computed!.displayTitle).toBeInstanceOf(Function);
    expect(schemaWithComputed.models.chats.computed!.icon).toBeInstanceOf(Function);
    expect(schemaWithComputed.models.chats.computed!.hasAgent).toBeInstanceOf(Function);
  });

  it('computed functions execute correctly', () => {
    const computed = schemaWithComputed.models.chats.computed!;
    const self = { title: '', metadata: '{"icon":"rocket"}', userId: 'u1' } as Record<string, unknown>;

    expect(computed.displayTitle(self)).toBe('Untitled');
    expect(computed.icon(self)).toBe('message-circle'); // metadataObject not on self
    expect(computed.hasAgent(self)).toBe(false);
  });
});
