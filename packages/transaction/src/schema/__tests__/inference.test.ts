/**
 * Type-level + runtime tests for Zod-based schema inference.
 */

import { z } from 'zod';
import { defineSchema, model, field, relation } from '../index.js';
import type { Model, InferCreate } from '../index.js';

// ── Define a test schema ──────────────────────────────────────────────────

const schema = defineSchema({
  items: model(
    {
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      priority: z.number().default(0),
      workspaceId: z.string().optional(),
      assigneeId: z.string().optional(),
      dueDate: z.date().optional(),
      isBlocked: z.boolean().default(false),
      metadata: z.object({ tags: z.array(z.string()), source: z.string().optional() }).optional(),
    },
    {
      relations: {
        workspace: relation.belongsTo('workspaces', 'workspaceId'),
        comments: relation.hasMany('comments', 'itemId'),
      },
    }
  ),

  workspaces: model(
    {
      name: z.string(),
      description: z.string().optional(),
      status: z.enum(['active', 'archived']).default('active'),
    },
    {
      relations: {
        items: relation.hasMany('items', 'workspaceId'),
      },
    }
  ),

  comments: model({
    content: z.string(),
    itemId: z.string(),
    authorId: z.string(),
  }),

  users: model({
    name: z.string(),
    email: field.id(), // indexed string
  }),
});

// ── Type inference tests (compile-time) ───────────────────────────────────

type Item = Model<typeof schema, 'items'>;
type Workspace = Model<typeof schema, 'workspaces'>;
type Comment = Model<typeof schema, 'comments'>;

type CreateItem = InferCreate<typeof schema, 'items'>;

// Compile-time assertion helper
type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

// Logical identity is the only universal model field.
type _ItemHasId = Expect<Equal<Item['id'], string>>;
type _ItemHasNoCreatedAt = Expect<Equal<'createdAt' extends keyof Item ? true : false, false>>;

// Item has typed fields
type _ItemHasTitle = Expect<Equal<Item['title'], string>>;
type _ItemHasStatus = Expect<Equal<Item['status'], 'todo' | 'in_progress' | 'done'>>;
type _ItemHasPriority = Expect<Equal<Item['priority'], number>>;
type _ItemHasBlocked = Expect<Equal<Item['isBlocked'], boolean>>;

// Optional fields
type _ItemDescOptional = Expect<Equal<Item['description'], string | undefined>>;
type _ItemWorkspaceIdOptional = Expect<Equal<Item['workspaceId'], string | undefined>>;
type _ItemDueDateOptional = Expect<Equal<Item['dueDate'], Date | undefined>>;

// JSON field preserves type
type _ItemMetadata = Expect<
  Equal<Item['metadata'], { tags: string[]; source?: string } | undefined>
>;

// Create input — fields with defaults are optional
type _CreateItemTitleRequired = Expect<Equal<CreateItem['title'], string>>;

// ── Runtime tests ─────────────────────────────────────────────────────────

describe('Zod Schema DSL', () => {
  it('defineSchema returns schema with models', () => {
    expect(schema.models).toBeDefined();
    expect(schema.models.items).toBeDefined();
    expect(schema.models.workspaces).toBeDefined();
    expect(schema.models.comments).toBeDefined();
    expect(schema.models.users).toBeDefined();
  });

  it('model has Zod schema that validates', () => {
    const itemSchema = schema.models.items.schema;

    const valid = itemSchema.safeParse({
      title: 'Test item',
      status: 'todo',
      priority: 1,
    });
    expect(valid.success).toBe(true);

    const invalid = itemSchema.safeParse({
      // missing required 'title'
      status: 'todo',
    });
    expect(invalid.success).toBe(false);
  });

  it('defaults are applied by Zod', () => {
    const itemSchema = schema.models.items.schema;

    const result = itemSchema.parse({ title: 'Test' });
    expect(result.status).toBe('todo');
    expect(result.priority).toBe(0);
    expect(result.isBlocked).toBe(false);
  });

  it('optional fields accept undefined', () => {
    const itemSchema = schema.models.items.schema;

    const result = itemSchema.parse({ title: 'Test' });
    expect(result.description).toBeUndefined();
    expect(result.workspaceId).toBeUndefined();
    expect(result.dueDate).toBeUndefined();
  });

  it('enum fields reject invalid values', () => {
    const itemSchema = schema.models.items.schema;

    const result = itemSchema.safeParse({ title: 'Test', status: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('validators add logical identity without inventing audit fields', () => {
    const fullValidator = schema.validators.items;

    const result = fullValidator.safeParse({
      id: '123',
      createdAt: new Date(),
      updatedAt: new Date(),
      title: 'Test',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: '123', title: 'Test', status: 'todo', priority: 0, isBlocked: false });
    }
  });

  it('relations have correct metadata', () => {
    const itemRelations = schema.models.items.relations;
    expect(itemRelations.workspace.type).toBe('belongsTo');
    expect(itemRelations.workspace.target).toBe('workspaces');
    expect(itemRelations.workspace.foreignKey).toBe('workspaceId');

    expect(itemRelations.comments.type).toBe('hasMany');
    expect(itemRelations.comments.target).toBe('comments');
    expect(itemRelations.comments.foreignKey).toBe('itemId');
  });

  it('foreignKeyColumn defaults to foreignKey when no casing is set', () => {
    // Identity default preserves backward-compat for consumers whose DB
    // columns already match their JS field names (or who handle naming
    // themselves). Client InstanceCache + server SQL compiler can both read
    // `foreignKeyColumn` safely either way.
    const itemRelations = schema.models.items.relations;
    expect(itemRelations.workspace.foreignKeyColumn).toBe('workspaceId');
    expect(itemRelations.comments.foreignKeyColumn).toBe('itemId');
  });

  it('casing: "snake_case" derives foreignKeyColumn from camelCase foreignKey', () => {
    const snakeSchema = defineSchema({
      messages: model(
        { chatId: z.string(), role: z.string() },
        {
          relations: { parts: relation.hasMany('messageParts', 'messageId') },
        }
      ),
      messageParts: model(
        { messageId: z.string(), order: z.number() },
        {
          relations: { message: relation.belongsTo('messages', 'messageId') },
        }
      ),
    }, { casing: 'snake_case' });

    // JS-facing foreignKey is unchanged — client InstanceCache still reads
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
      items: model(
        { workspaceId: z.string() },
        {
          relations: { workspace: relation.belongsTo('workspaces', 'workspaceId') },
        }
      ),
      workspaces: model({ name: z.string() }),
    }, { casing: (key) => key.toUpperCase() });

    expect(upperSchema.models.items.relations.workspace.foreignKeyColumn).toBe('WORKSPACEID');
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
    {
      typename: 'Chat',
      computed: {
        displayTitle: (self: Record<string, unknown>): string =>
          (self.title as string) || 'Untitled',
        metadataObject: (self: Record<string, unknown>): Record<string, unknown> => {
          try { return JSON.parse((self.metadata as string) || '{}'); }
          catch { return {}; }
        },
        icon: (self: Record<string, unknown>): string =>
          ((self.metadataObject as Record<string, unknown>)?.icon as string) ?? 'message-circle',
        hasAgent: (self: Record<string, unknown>): boolean => !!(self.agentId),
      },
    }
  ),
});

type ChatRow = Model<typeof schemaWithComputed, 'chats'>;

// Compile-time: Zod fields are typed
type _ChatTitle = Expect<Equal<ChatRow['title'], string>>;
type _ChatMetadata = Expect<Equal<ChatRow['metadata'], string>>;
type _ChatUserId = Expect<Equal<ChatRow['userId'], string>>;

// Compile-time: computed getters have inferred return types
type _ChatDisplayTitle = Expect<Equal<ChatRow['displayTitle'], string>>;
type _ChatIcon = Expect<Equal<ChatRow['icon'], string>>;
type _ChatHasAgent = Expect<Equal<ChatRow['hasAgent'], boolean>>;
type _ChatMetadataObject = Expect<Equal<ChatRow['metadataObject'], Record<string, unknown>>>;

// Compile-time: only logical identity is universal.
type _ChatId = Expect<Equal<ChatRow['id'], string>>;
type _ChatHasNoCreatedAt = Expect<Equal<'createdAt' extends keyof ChatRow ? true : false, false>>;

describe('Computed getter inference', () => {
  it('computed getters are present in the Model type', () => {
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
