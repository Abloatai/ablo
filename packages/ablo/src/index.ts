export * from '@abloatai/transaction';
export { Ablo as default } from '@abloatai/transaction';

/**
 * The logger shape a caller passes in, and the no-op it can pass instead.
 *
 * Anything that supplies its own logging to the client has to name this type,
 * so it belongs on the surface the client itself is imported from.
 */
export { noopLogger } from '@abloatai/transaction/logger';
export type { Logger } from '@abloatai/transaction/logger';

/** Application registration, owned here so augmentation survives re-exports. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}
type PublicRegister = Register;

// Connect the public registration to its downstream resolvers. A re-export
// alone creates a different augmentation target in published declarations.
declare module '@abloatai/transaction/types/global' {
  interface Register extends PublicRegister {}
}
