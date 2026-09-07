import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

const hints: Readonly<Record<string, string>> = {
  useSync: 'Use useAbloClient() for the writable client; await client.ready() before initialized operations.',
  useSyncStatus: 'Use useAblo(client => client.status).',
  usePeers: 'Use usePresence(model, id, { excludeSelf: true }) for a record, or select client.presence.others.',
  useMutationFailureListener: 'Use useMutationFailure(listener); the hook owns subscription cleanup and client rotation.',
  useErrorListener: 'Handle provider startup failures with AbloProvider onError.',
  useCurrentUserId: 'Read identity from your application authentication context.',
  useSDKSyncStore: 'Use public client operations; custom store adapters use getAbloStore(client) from @abloatai/ablo/client.',
  useSyncStore: 'Use public client operations; custom store adapters use getAbloStore(client) from @abloatai/ablo/client.',
  ClientSideSuspense: 'Supply application UI through AbloProvider fallback.',
  DefaultFallback: 'Supply application UI through AbloProvider fallback.',
  GroupScope: 'Presence now scopes by model and record id.',
};

export function reactMigrationHints(source: SourceFile): Array<{ node: Node; hint: string }> {
  const results: Array<{ node: Node; hint: string }> = [];
  for (const declaration of source.getImportDeclarations()) {
    if (!['@abloatai/ablo/react', '@abloatai/humans/react'].includes(declaration.getModuleSpecifierValue())) continue;
    for (const specifier of declaration.getNamedImports()) {
      const hint = hints[specifier.getName()];
      if (hint) results.push({ node: specifier, hint });
      if (specifier.getName() !== 'useAblo') continue;
      const symbol = (specifier.getAliasNode() ?? specifier.getNameNode()).getSymbol();
      for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getArguments().length === 0 && call.getExpression().getSymbol() === symbol) {
          results.push({ node: call, hint: 'Replace the zero-argument useAblo call with useAbloClient(); useAblo(selector) reads snapshots.' });
        }
      }
    }
  }
  return results;
}
