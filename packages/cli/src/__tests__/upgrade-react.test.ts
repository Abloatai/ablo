import { Project } from 'ts-morph';
import { reactMigrationHints } from '../upgrade/react.js';

it.each(['@abloatai/ablo/react', '@abloatai/humans/react'])('flags removed provider imports and props from %s, including aliases', (module) => {
  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile('providers.tsx', `
    import { SyncProvider, SyncProvider as Legacy, AbloProvider, AbloProvider as Provider } from '${module}';
    import { AbloProvider as Other } from 'other-library';
    const app = <AbloProvider client={client} userId={user.id}><Child /></AbloProvider>;
    const alias = <Provider client={client} userId={user.id} />;
    const current = <Provider client={client} />;
    const unrelated = <Other userId={user.id} />;
    function shadow(Provider: any) { return <Provider userId={user.id} />; }
  `);
  const hints = reactMigrationHints(source);
  expect(hints.map(result => result.node.getText())).toEqual([
    'SyncProvider', 'SyncProvider as Legacy', 'userId={user.id}', 'userId={user.id}',
  ]);
  expect(hints[0]?.hint).toContain('AbloProvider');
  expect(hints[2]?.hint).toContain('Remove');
});

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
