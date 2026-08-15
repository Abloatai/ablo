/**
 * Unit tests for the webhook event catalog mapping. Pure — no DB, no network.
 * Pins the `<model>.<verb>` type derivation, the syncId-as-id (dedupe+order),
 * the jsonb-string normalization, and that internal sync deltas don't emit.
 */
import { deltaToWebhookEvent, type WebhookSourceDelta } from '../events.js';

const base: WebhookSourceDelta = {
  id: 42,
  actionType: 'U',
  modelName: 'Entry',
  modelId: 's1',
  data: { id: 's1', title: 'hello' },
  createdAt: '2026-06-04T00:00:00.000Z',
};

describe('deltaToWebhookEvent', () => {
  it('maps action chars to customer verbs (I/U/D/A/V)', () => {
    const cases: [string, string][] = [
      ['I', 'entry.created'],
      ['U', 'entry.updated'],
      ['D', 'entry.deleted'],
      ['A', 'entry.archived'],
      ['V', 'entry.unarchived'],
    ];
    for (const [actionType, type] of cases) {
      expect(deltaToWebhookEvent({ ...base, actionType })?.type).toBe(type);
    }
  });

  it('builds a stable event: id = syncId, model preserved, data = the row', () => {
    const ev = deltaToWebhookEvent(base)!;
    expect(ev).toEqual({
      id: '42',
      type: 'entry.updated',
      model: 'Entry',
      objectId: 's1',
      syncId: 42,
      data: { id: 's1', title: 'hello' },
      createdAt: '2026-06-04T00:00:00.000Z',
    });
  });

  it('exposes syncId for dedupe and ordering', () => {
    const a = deltaToWebhookEvent({ ...base, id: 100 })!;
    const b = deltaToWebhookEvent({ ...base, id: 101 })!;
    expect(a.id).toBe('100');
    expect(b.syncId).toBe(101);
    expect(b.syncId).toBeGreaterThan(a.syncId); // monotonic → orderable
  });

  it('normalizes jsonb returned as a raw string', () => {
    const ev = deltaToWebhookEvent({ ...base, data: '{"id":"s1","title":"raw"}' })!;
    expect(ev.data).toEqual({ id: 's1', title: 'raw' });
  });

  it('carries null data on a delete', () => {
    const ev = deltaToWebhookEvent({ ...base, actionType: 'D', data: null })!;
    expect(ev.type).toBe('entry.deleted');
    expect(ev.data).toBeNull();
  });

  it('does NOT emit for internal sync deltas (C / G / S)', () => {
    for (const actionType of ['C', 'G', 'S']) {
      expect(deltaToWebhookEvent({ ...base, actionType })).toBeNull();
    }
  });

  it('lowercases only the type, preserving the wire model name', () => {
    const ev = deltaToWebhookEvent({ ...base, modelName: 'EntryDetail' })!;
    expect(ev.type).toBe('entrydetail.updated');
    expect(ev.model).toBe('EntryDetail');
  });
});
