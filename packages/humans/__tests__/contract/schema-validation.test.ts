/**
 * Contract test: Schema DSL validation
 *
 * Verifies the public schema builder API produces correct runtime metadata.
 * These tests protect the API surface that SDK consumers depend on.
 */

import { defineSchema, model, field, relation } from '@abloatai/transaction/schema';
import { createTestContext } from '../../src/local/testing';

describe('Contract: Schema DSL', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe('defineSchema()', () => {
    it('should return a schema object with models keyed by name', () => {
      const schema = defineSchema({
        items: model({
          title: field.string(),
          status: field.string(),
        }),
        workspaces: model({
          name: field.string(),
        }),
      });

      expect(schema).toBeDefined();
      expect(schema.models).toBeDefined();
      expect(schema.models.items).toBeDefined();
      expect(schema.models.workspaces).toBeDefined();
    });

    it('should preserve field runtime metadata', () => {
      const schema = defineSchema({
        items: model({
          title: field.string(),
          count: field.number(),
          active: field.boolean(),
          tags: field.json(),
        }),
      });

      const fields = schema.models.items.fields;
      expect(fields.title?.type).toBe('string');
      expect(fields.count?.type).toBe('number');
      expect(fields.active?.type).toBe('boolean');
      expect(fields.tags?.type).toBe('json');
    });

    it('should handle optional fields', () => {
      const schema = defineSchema({
        items: model({
          title: field.string(),
          description: field.string().optional(),
        }),
      });

      const fields = schema.models.items.fields;
      expect(fields.title?.isOptional).toBe(false);
      expect(fields.description?.isOptional).toBe(true);
    });

    it('should handle indexed fields', () => {
      const schema = defineSchema({
        items: model({
          title: field.string(),
          workspaceId: field.string().indexed(),
        }),
      });

      const fields = schema.models.items.fields;
      expect(fields.workspaceId?.isIndexed).toBe(true);
    });

    it('should handle physical column overrides', () => {
      const schema = defineSchema({
        messages: model({
          senderId: field.string().from('sender_id').indexed(),
          threadId: field.string().indexed().from('thread_id'),
        }),
      });

      const fields = schema.models.messages.fields;
      const senderId = fields.senderId;
      const threadId = fields.threadId;
      if (!senderId) throw new Error('expected senderId field metadata');
      if (!threadId) throw new Error('expected threadId field metadata');
      expect(senderId.column).toBe('sender_id');
      expect(senderId.isIndexed).toBe(true);
      expect(threadId.column).toBe('thread_id');
      expect(threadId.isIndexed).toBe(true);
    });

    describe('sessionSettings (ADR 0011)', () => {
      const oneModel = { items: model({ title: field.string() }) };

      it('accepts valid mappings and exposes them on the schema, defaulting to empty', () => {
        expect(defineSchema(oneModel).sessionSettings).toEqual({});
        const schema = defineSchema(oneModel, {
          sessionSettings: {
            'app.current_org': 'orgId',
            'app.current_app_env': 'environment',
          },
        });
        expect(schema.sessionSettings).toEqual({
          'app.current_org': 'orgId',
          'app.current_app_env': 'environment',
        });
        // Uniqueness needs no runtime check — the map is keyed by the setting
        // name, so the same setting can't be declared twice.
      });

      it('rejects a mapping that reassigns an engine-reserved setting', () => {
        expect(() =>
          defineSchema(oneModel, {
            sessionSettings: { search_path: 'orgId' },
          }),
        ).toThrow(/Ablo already manages/);
        expect(() =>
          defineSchema(oneModel, {
            sessionSettings: { 'app.current_org_id': 'orgId' },
          }),
        ).toThrow(/reassign it/);
      });

      it('rejects an empty setting name', () => {
        expect(() =>
          defineSchema(oneModel, { sessionSettings: { '  ': 'orgId' } }),
        ).toThrow(/key is empty/);
      });
    });
  });

  describe('relation()', () => {
    it('should preserve relation runtime metadata', () => {
      const schema = defineSchema({
        items: model(
          {
            title: field.string(),
            workspaceId: field.string().optional(),
          },
          {
            relations: {
              workspace: relation.belongsTo('workspaces', 'workspaceId'),
            },
          }
        ),
        workspaces: model({
          name: field.string(),
        }),
      });

      const relations = schema.models.items.relations;
      expect(relations).toBeDefined();
      expect(relations?.workspace).toBeDefined();
      if (relations?.workspace) {
        expect(relations.workspace.type).toBe('belongsTo');
        expect(relations.workspace.target).toBe('workspaces');
        expect(relations.workspace.foreignKey).toBe('workspaceId');
      }
    });
  });
});
