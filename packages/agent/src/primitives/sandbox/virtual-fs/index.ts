/**
 * Virtual filesystem layer — composes path-prefix backends behind one
 * Sandbox-shaped filesystem interface.
 */

export { VirtualFs } from './router';
export {
  UnsupportedOperationError,
  type VirtualFsBackend,
} from './types';

export { ScratchBackend } from './scratch';
export {
  StaticBundleBackend,
  type StaticBundleBackendOptions,
} from './static-bundle';
export {
  StateProjectionBackend,
  type StateProvider,
  type StateProjectionBackendOptions,
} from './state-projection';

export { globToRegex } from './glob-utils';
