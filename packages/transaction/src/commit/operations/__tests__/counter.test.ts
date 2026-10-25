import { describe, expect, it } from '@jest/globals';
import { CounterSession, applyCounterOperation, foldCounterHistory, reconcileCounterEdit, type CounterHistory } from '../../counter/index.js';
import { acceptedOperationReferenceSchema } from '../contract.js';

function setup() {
  const log: CounterHistory = { base: { epoch: 'counter', version: 0, value: 0 }, edits: [] };
  const clients = Array.from({ length: 4 }, () => new CounterSession({ snapshot: log.base }));
  const commit = (index: number) => {
    const client = clients[index]!;
    const edit = client.nextEdit();
    if (!edit) return;
    const accepted = reconcileCounterEdit(log, edit, foldCounterHistory(log).value);
    log.edits.push(accepted);
    for (const receiver of clients) receiver.receive(accepted);
    return accepted;
  };
  return { log, clients, commit };
}

describe('shared operation lifecycle with integer increments', () => {
  it('converges over generated four-writer schedules, restores sealed requests and preserves remote contributions during undo', () => {
    for (let seed = 1; seed <= 100; seed++) {
      let random = seed;
      const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
      const { log, clients, commit } = setup();
      const amounts = clients.map(() => [] as number[]);
      let expected = 0;
      for (let round = 0; round < 12; round++) {
        const writer = next() % clients.length;
        const amount = next() % 21 - 10;
        amounts[writer]!.push(amount);
        clients[writer]!.edit(`${seed}:${round}`, amount);
        expected += amount;
        clients[writer]!.nextEdit();
        clients[writer] = new CounterSession(JSON.parse(JSON.stringify(clients[writer]!.exportState())));
        commit(next() % clients.length);
      }
      for (let round = 0; round < 12; round++) for (let writer = 0; writer < clients.length; writer++) commit(writer);
      expect(foldCounterHistory(log).value).toBe(expected);
      for (const client of clients) expect(client.value).toBe(expected);
      const writer = amounts.findIndex((entries) => entries.length > 0);
      expect(clients[writer]!.undo(`undo:${seed}`)).toBe(true);
      expected -= amounts[writer]!.at(-1)!;
      const accepted = commit(writer)!;
      // A duplicate delivery must not add the amount twice.
      for (const client of clients) client.receive(accepted);
      for (const client of clients) expect(client.value).toBe(expected);
    }
  });

  it('does not mutate a sealed increment when remote operations arrive', () => {
    const { clients, commit } = setup();
    clients[0]!.edit('a', 3);
    const sealed = clients[0]!.nextEdit();
    clients[1]!.edit('b', 7);
    commit(1);
    expect(clients[0]!.nextEdit()).toEqual(sealed);
    commit(0);
    expect(clients[0]!.value).toBe(10);
  });

  it('keeps unresolved edits after a gap or epoch change', () => {
    const { clients } = setup();
    const client = clients[0]!;
    client.edit('local', 4);
    const state = client.exportState();
    expect(() => client.receive({ id: 'remote', epoch: 'counter', version: 2, operation: 1 })).toThrow();
    expect(client.exportState()).toEqual(state);
    expect(() => client.receive({ id: 'remote', epoch: 'new', version: 1, operation: 1 })).toThrow();
    expect(client.exportState()).toEqual(state);
  });

  it('validates safe integers and checks the result on the current authoritative value', () => {
    expect(() => applyCounterOperation(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => applyCounterOperation(0, 0.5)).toThrow();
    expect(() => applyCounterOperation(Number.NaN, 1)).toThrow();
    const history: CounterHistory = { base: { epoch: 'counter', version: 9, value: 1 }, edits: [] };
    // Arithmetic commutes, but an expired replay basis cannot prove that an ID is new.
    expect(() => reconcileCounterEdit(history, { id: 'increment', epoch: 'counter', baseVersion: 0, operation: 2 }, 1)).toThrow();
    expect(reconcileCounterEdit(history, { id: 'increment', epoch: 'counter', baseVersion: 9, operation: 2 }, 1).operation).toBe(2);
    expect(() => reconcileCounterEdit(history, { id: 'increment', epoch: 'counter', baseVersion: 9, operation: 2 }, 9)).toThrow();
  });

  it('accepts only bounded versioned references, without a text payload', () => {
    expect(acceptedOperationReferenceSchema.parse({ id: 'edit', kind: 'counter', field: 'count', epoch: 'base', version: 1 }).kind).toBe('counter');
    expect(acceptedOperationReferenceSchema.safeParse({ id: 'edit', kind: 'text', field: 'body', epoch: 'base', version: 0 }).success).toBe(false);
  });
});
