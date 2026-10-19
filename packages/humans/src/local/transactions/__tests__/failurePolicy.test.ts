import {
  AbloClaimedError,
  AbloConnectionError,
  AbloStaleContextError,
} from '@abloatai/transaction/errors';
import { isDefinitiveRejection } from '../mutations/failurePolicy.js';

it('retains disconnected requests while respecting authoritative write refusals', () => {
  expect(isDefinitiveRejection(new AbloConnectionError('offline', { code: 'ws_not_ready' }))).toBe(false);
  expect(isDefinitiveRejection(new AbloStaleContextError('changed', { code: 'stale_context' }))).toBe(true);
  expect(isDefinitiveRejection(new AbloClaimedError('held', { code: 'entity_claimed' }))).toBe(true);
});
