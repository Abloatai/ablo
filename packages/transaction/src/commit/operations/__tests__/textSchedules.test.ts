import { describe, expect, it } from '@jest/globals';
import { TextSession, foldTextHistory, reconcileTextEdit, type TextHistory, type TextOperation } from '../../text/index.js';

describe('shared text reconciliation', () => {
  it('converges over generated four-writer Unicode histories with deletes, delayed ACKs and restored clients', () => {
    for (let seed = 1; seed <= 100; seed++) {
      let random = seed;
      const next = () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0);
      const log: TextHistory = { base: { epoch: 'text', version: 0, value: 'hello🤖' }, edits: [] };
      const clients = Array.from({ length: 4 }, () => new TextSession({ snapshot: log.base }));
      const deliver = (writer: number) => { for (const edit of log.edits) clients[writer]!.receive(edit); };
      const commit = (writer: number) => {
        const edit = clients[writer]!.nextEdit();
        if (!edit) return;
        log.edits.push(reconcileTextEdit(log, edit, foldTextHistory(log).value));
        deliver(writer);
      };
      for (let round = 0; round < 30; round++) {
        const writer = (next() >>> 16) % clients.length;
        if (next() % 2) deliver(writer);
        const client = clients[writer]!;
        const chars = Array.from(client.value);
        const remove = chars.length > 0 && next() % 3 === 0;
        const position = (next() >>> 8) % (chars.length + (remove ? 0 : 1));
        const operation: TextOperation = position > 0 ? [position] : [];
        operation.push(remove ? { d: chars[position]! } : ['x', '🌍', 'y'][next() % 3]!);
        client.edit(`${seed}:${round}`, operation);
        client.nextEdit();
        clients[writer] = new TextSession(JSON.parse(JSON.stringify(client.exportState())));
        if (next() % 2) commit((next() >>> 16) % clients.length);
      }
      for (let round = 0; round < 30; round++) for (let writer = 0; writer < clients.length; writer++) { deliver(writer); commit(writer); }
      for (let writer = 0; writer < clients.length; writer++) deliver(writer);
      const value = foldTextHistory(log).value;
      for (const client of clients) { expect(client.value).toBe(value); expect(client.exportState().pending).toHaveLength(0); }
      expect(new Set(log.edits.map((edit) => edit.id)).size).toBe(30);
    }
  });
});
