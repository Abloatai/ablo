/**
 * The hand-off the identity flow performs once a credential resolves: it names
 * the account scope and the sync groups everything downstream should read under.
 *
 * The core defines the port; the consumer supplies the implementation. That
 * keeps identity resolution — which is confirmation's business — from depending on
 * whatever happens to materialise rows on the other side of it (ADR 0016). The
 * reactive engine's `BootstrapFetcher` satisfies this structurally.
 */
export interface BootstrapScope {
  /** Bind subsequent reads to one account's cache partition. */
  setCacheScope(cacheScope: string): void;
  /** Narrow subsequent reads to the sync groups the credential authorises. */
  setSyncGroups(syncGroups: readonly string[] | undefined): void;
}
