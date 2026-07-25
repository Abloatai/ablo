/** React bindings for the optional human-facing local-state package. */
export { useReactive } from './useReactive.js';
export { useCurrentUserId } from './react/useCurrentUserId.js';
export { useErrorListener } from './react/useErrorListener.js';
export { useSyncStatus, type SyncStatusSnapshot } from './react/useSyncStatus.js';
export {
  useMutationFailureListener,
  type MutationFailurePayload,
} from './react/useMutationFailureListener.js';

export {
  AbloProvider,
  useJoin,
  usePeers,
  useSync,
  useSyncStore,
  type AbloProviderProps,
  type ParticipantScope,
  type ParticipantStatus,
  type UseJoinOptions,
  type UseJoinReturn,
} from './react/AbloProvider.js';

export {
  ClientSideSuspense,
  type ClientSideSuspenseProps,
} from './react/ClientSideSuspense.js';

export { DefaultFallback } from './react/DefaultFallback.js';

export {
  createAbloReact,
  type AbloReactBinding,
} from './react/createAbloReact.js';

export {
  useAblo,
  type UseAbloHydratedModelResult,
  type UseAbloModelOptions,
  type UseAbloModelResult,
} from './react/useAblo.js';

export {
  useMutators,
  type InvokerFor,
  type MutatorInvokers,
  type UseMutatorsOptions,
} from './react/useMutators.js';

export {
  useUndoScope,
  type UseUndoScopeResult,
} from './react/useUndoScope.js';

export type {
  DefaultSyncShape,
  ResolveSchema,
  ResolveUserMeta,
  ResolveClaimMeta,
  ResolveModelKey,
} from '@ablo/transaction/types/global';

export { ModelScope } from '@ablo/transaction/types';
export type { SyncStoreContract } from './react/context.js';
export type { MutateActions } from './local/mutators/mutateActions.js';
export type {
  ReaderActions,
  ReaderFindOptions,
} from './local/mutators/readerActions.js';
