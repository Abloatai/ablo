import { Project } from 'ts-morph';
import { reactMigrationHints } from '../upgrade/react.js';

it('finds aliased old hooks and zero-argument clients without flagging selectors or unrelated hooks', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile('component.ts', `
    import { useAblo as read, usePeers as peers, useSDKSyncStore } from '@abloatai/ablo/react';
    import { useSyncStatus } from 'other-library';
    read();
    read(client => client.status);
    function unrelated(read: () => void) { read(); }
  `);
  const hints = reactMigrationHints(source);
  expect(hints).toHaveLength(3);
  expect(hints.map(result => result.hint).join('\n')).toContain('useAbloClient');
  expect(hints.map(result => result.hint).join('\n')).toContain('excludeSelf');
  expect(hints.map(result => result.hint).join('\n')).toContain('getAbloStore');
});
