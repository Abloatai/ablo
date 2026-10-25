import { describe, expect, it } from '@jest/globals';
import {
  TextSession, foldTextHistory, reconcileTextEdit,
  type TextEdit, type TextHistory,
} from '../index.js';

function setup() {
  const log: TextHistory = { base: { epoch: 'base', version: 0, value: 'hello' }, edits: [] };
  const clients = [new TextSession({ snapshot: log.base }), new TextSession({ snapshot: log.base })];
  function commit(edit: TextEdit) {
    const accepted = reconcileTextEdit(log, edit, foldTextHistory(log).value);
    log.edits.push(accepted);
    return accepted;
  }
  function flush() {
    for (const client of clients) for (const accepted of log.edits) client.receive(accepted);
    for (let round = 0; round < 20; round++) {
      let active = false;
      for (const client of clients) {
        const edit = client.nextEdit();
        if (!edit) continue;
        active = true;
        const accepted = commit(edit);
        for (const receiver of clients) receiver.receive(accepted);
      }
      if (!active) return;
    }
    throw new Error('Text clients failed to drain their pending edits.');
  }
  return { log, clients, commit, flush };
}

describe('optimistic text session', () => {
  it('rebases an outstanding edit and later local edits before sending them', () => {
    const { clients: [alice, bob], commit, flush, log } = setup();
    alice!.edit('alice-first', ['X']);
    const outstanding = alice!.nextEdit()!;
    alice!.edit('alice-second', [1, 'Z']);
    bob!.edit('bob-first', [{ d: 'h' }]);
    const acceptedBob = commit(bob!.nextEdit()!);
    alice!.receive(acceptedBob);
    bob!.receive(acceptedBob);
    expect(alice!.value).toBe('XZello');
    expect(alice!.nextEdit()).toEqual(outstanding);
    const acceptedAlice = commit(outstanding);
    alice!.receive(acceptedAlice);
    bob!.receive(acceptedAlice);
    flush();
    expect(alice!.value).toBe('XZello');
    expect(bob!.value).toBe(alice!.value);
    expect(foldTextHistory(log).value).toBe(alice!.value);
  });

  it('restores an in-flight edit after a lost acknowledgement and ignores replayed deliveries', () => {
    const { clients, commit, flush } = setup();
    const alice = clients[0]!;
    alice.edit('first', ['X']);
    const sent = alice.nextEdit()!;
    const accepted = commit(sent);
    const recovered = new TextSession(JSON.parse(JSON.stringify(alice.exportState())));
    clients[0] = recovered;
    expect(recovered.nextEdit()).toEqual(sent);
    recovered.receive(accepted);
    recovered.receive(accepted);
    flush();
    expect(recovered.nextEdit()).toBeNull();
    expect(recovered.value).toBe('Xhello');
    expect(clients[1]!.value).toBe('Xhello');
  });

  it('undoes and redoes local edits without removing a peer insertion', () => {
    const { clients: [alice, bob], flush } = setup();
    alice!.edit('alice', ['X']);
    bob!.edit('bob', ['Y']);
    flush();
    expect(alice!.undo('undo')).toBe(true);
    flush();
    expect(alice!.value).toBe('Yhello');
    expect(bob!.value).toBe('Yhello');
    expect(alice!.redo('redo')).toBe(true);
    flush();
    expect(alice!.value).toBe('XYhello');
    expect(bob!.value).toBe(alice!.value);
  });

  it('undoes successive local edits and preserves a peer edit between them', () => {
    const { clients: [alice, bob], flush } = setup();
    alice!.edit('alice-1', ['X']);
    alice!.edit('alice-2', [1, 'Z']);
    bob!.edit('bob', [2, 'Y']);
    flush();
    alice!.undo('undo-2');
    flush();
    alice!.undo('undo-1');
    flush();
    expect(alice!.value).toBe('heYllo');
    expect(bob!.value).toBe(alice!.value);
    alice!.redo('redo-1');
    flush();
    alice!.redo('redo-2');
    flush();
    expect(alice!.value).toBe('XZheYllo');
  });

  it('keeps pending edits intact when a history gap or external fork requires recovery', () => {
    const session = new TextSession({ snapshot: { epoch: 'base', version: 0, value: 'hello' } });
    session.edit('local', ['X']);
    const state = session.exportState();
    expect(() => session.receive({ id: 'remote', epoch: 'base', version: 2, operation: ['Y'] })).toThrow('Missing');
    expect(session.exportState()).toEqual(state);
    expect(() => session.receive({ id: 'remote', epoch: 'external', version: 1, operation: ['Y'] })).toThrow('base changed');
    expect(session.exportState()).toEqual(state);
  });

  it('does not mutate state for invalid edits or acknowledgements', () => {
    const session = new TextSession({ snapshot: { epoch: 'base', version: 0, value: 'hello' } });
    const before = session.exportState();
    expect(() => session.edit('bad', [{ d: 99 }])).toThrow();
    expect(session.exportState()).toEqual(before);
    session.edit('local', ['X']);
    session.nextEdit();
    const pending = session.exportState();
    expect(() => session.receive({ id: 'local', epoch: 'base', version: 1, operation: ['wrong'] })).toThrow('disagrees');
    expect(session.exportState()).toEqual(pending);
  });

  it('converges with three writers, delayed delivery, in-flight retries and restored sessions', () => {
    for (let seed = 1; seed <= 30; seed++) {
      let randomState = seed;
      const random = (max: number) => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState % max;
      };
      const log: TextHistory = { base: { epoch: 'base', version: 0, value: 'a🤖bc' }, edits: [] };
      const clients = Array.from({ length: 3 }, () => new TextSession({ snapshot: log.base }));
      const acceptedIds = new Set<string>();
      const send = (client: TextSession) => {
        const edit = client.nextEdit();
        if (!edit || acceptedIds.has(edit.id)) return;
        log.edits.push(reconcileTextEdit(log, edit, foldTextHistory(log).value));
        acceptedIds.add(edit.id);
      };
      const deliver = (client: TextSession) => {
        const edit = log.edits[client.exportState().snapshot.version];
        if (edit) client.receive(edit);
      };
      for (let step = 0; step < 90; step++) {
        const index = random(3);
        const client = clients[index]!;
        switch (random(5)) {
          case 0:
          case 1: {
            const length = Array.from(client.value).length;
            const position = random(length + 1);
            const prefix = position ? [position] : [];
            const operation = position < length && random(3) === 0
              ? [...prefix, { d: 1 }]
              : [...prefix, random(2) ? 'X' : '🌍'];
            client.edit(`${seed}:${step}`, operation);
            break;
          }
          case 2: send(client); break;
          case 3: deliver(client); break;
          case 4: clients[index] = new TextSession(JSON.parse(JSON.stringify(client.exportState()))); break;
        }
      }
      for (let round = 0; round < 100; round++) {
        for (const client of clients) {
          for (const edit of log.edits) client.receive(edit);
          send(client);
        }
      }
      for (const client of clients) {
        for (const edit of log.edits) client.receive(edit);
        expect(client.value).toBe(foldTextHistory(log).value);
        expect(client.nextEdit()).toBeNull();
      }
    }
  });
});
