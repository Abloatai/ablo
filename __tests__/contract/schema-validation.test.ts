/**
 * Contract test: Schema DSL validation
 *
 * Verifies the public schema builder API produces correct runtime metadata.
 * These tests protect the API surface that SDK consumers depend on.
 */

import { defineSchema, model, field, relation } from '../../src/schema/index';
import { createTestContext } from '../../src/testing';

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
        tasks: model({
          title: field.string(),
          status: field.string(),
        }),
        projects: model({
          name: field.string(),
        }),
      });

      expect(schema).toBeDefined();
      expect(schema.models).toBeDefined();
      expect(schema.models.tasks).toBeDefined();
      expect(schema.models.projects).toBeDefined();
    });

    it('should preserve field runtime metadata', () => {
      const schema = defineSchema({
        tasks: model({
          title: field.string(),
          count: field.number(),
          active: field.boolean(),
          tags: field.json(),
        }),
      });

      const fields = schema.models.tasks.fields;
      expect(fields.title.type).toBe('string');
      expect(fields.count.type).toBe('number');
      expect(fields.active.type).toBe('boolean');
      expect(fields.tags.type).toBe('json');
    });

    it('should handle optional fields', () => {
      const schema = defineSchema({
        tasks: model({
          title: field.string(),
          description: field.string().optional(),
        }),
      });

      const fields = schema.models.tasks.fields;
      expect(fields.title.isOptional).toBe(false);
      expect(fields.description.isOptional).toBe(true);
    });

    it('should handle indexed fields', () => {
      const schema = defineSchema({
        tasks: model({
          title: field.string(),
          projectId: field.string().indexed(),
        }),
      });

      const fields = schema.models.tasks.fields;
      expect(fields.projectId.isIndexed).toBe(true);
    });
  });

  describe('relation()', () => {
    it('should preserve relation runtime metadata', () => {
      const schema = defineSchema({
        tasks: model(
          {
            title: field.string(),
            projectId: field.string().optional(),
          },
          {
            project: relation.belongsTo('projects', 'projectId'),
          }
        ),
        projects: model({
          name: field.string(),
        }),
      });

      const relations = schema.models.tasks.relations;
      expect(relations).toBeDefined();
      expect(relations?.project).toBeDefined();
      if (relations?.project) {
        expect(relations.project.type).toBe('belongsTo');
        expect(relations.project.target).toBe('projects');
        expect(relations.project.foreignKey).toBe('projectId');
      }
    });
  });
});
