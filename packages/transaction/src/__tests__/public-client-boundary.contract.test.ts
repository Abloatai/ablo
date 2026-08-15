/**
 * CONTRACT — one schema-backed public client boundary.
 *
 * String-keyed model routing, HTTP envelopes, and wire receipts belong to the
 * private transport. Public callers construct through `Ablo({ schema })`, use
 * `ablo.<model>`, and name the raw batch result as `Ablo.Commit.Receipt`.
 */

import Ablo, { type AbloHttpClient } from '../index';
import { defineSchema, model, z } from '../schema/index';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

const schema = defineSchema({
  items: model({ title: z.string() }, { typename: 'Item' }),
});

type HttpClient = AbloHttpClient<typeof schema.models>;
type BatchReceipt = Ablo.Commit.Receipt;
type ModelOperations = Ablo.Model.Operations<
  { readonly id: string; readonly title: string },
  { readonly title: string }
>;
type HeldClaim = Ablo.Claim.Held<{ readonly id: string; readonly title: string }>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _NoDynamicModelAccessor = Expect<
  Equal<'model' extends keyof HttpClient ? true : false, false>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _BatchReceiptUsesPublicId = Expect<Equal<BatchReceipt['id'], string>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _BatchReceiptHasNoWireObject = Expect<
  Equal<'object' extends keyof BatchReceipt ? true : false, false>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _NamespacedModelOperationsHasRetrieve = Expect<
  Equal<'retrieve' extends keyof ModelOperations ? true : false, true>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _NamespacedHeldClaimHasRelease = Expect<
  Equal<HeldClaim['release'] extends (...args: never[]) => unknown ? true : false, true>
>;

// The old root type was a private wire envelope with
// `{ object, clientTxId, serverTxId }`. The only public receipt name now lives
// under the batch API namespace above.
// @ts-expect-error — no flat protocol-envelope receipt is exported
type _NoFlatWireReceipt = import('../index').CommitReceipt; // eslint-disable-line @typescript-eslint/no-unused-vars
// @ts-expect-error — model clients are named through the `Ablo.Model` namespace
type _NoFlatModelOperations = import('../index').ModelOperations; // eslint-disable-line @typescript-eslint/no-unused-vars
// @ts-expect-error — model claim params live under `Ablo.Model`
type _NoFlatClaimParams = import('../index').ClaimParams; // eslint-disable-line @typescript-eslint/no-unused-vars
// @ts-expect-error — observed claims live at `Ablo.Claim`
type _NoFlatClaim = import('../index').Claim; // eslint-disable-line @typescript-eslint/no-unused-vars
// @ts-expect-error — heartbeat options live at `Ablo.ClaimHeartbeatOptions`
type _NoFlatClaimHeartbeatOptions = import('../index').ClaimHeartbeatOptions; // eslint-disable-line @typescript-eslint/no-unused-vars
// @ts-expect-error — transport-specific claim API types are inferred from the client
type _NoFlatHttpClaimApi = import('../index').HttpClaimApi; // eslint-disable-line @typescript-eslint/no-unused-vars
// @ts-expect-error — dependency-injection construction options are monorepo-internal
type _NoPublicInternalOptions = import('../index').InternalAbloOptions; // eslint-disable-line @typescript-eslint/no-unused-vars
// @ts-expect-error — the public core subpath does not expose client construction internals
type _NoPublicCoreInternalOptions = import('../index').InternalAbloOptions; // eslint-disable-line @typescript-eslint/no-unused-vars

function compileOnlyConstruction(): void {
  const http = Ablo({
    schema,
    apiKey: 'sk_test_boundary',
    transport: 'http',
  });

  // @ts-expect-error — every public construction requires a schema
  void Ablo({ apiKey: 'sk_test_boundary' });
  // @ts-expect-error — `null` cannot opt into a schema-less client
  void Ablo({ schema: null, apiKey: 'sk_test_boundary', transport: 'http' });
  // @ts-expect-error — string-keyed model routing is private transport machinery
  void http.model('items'); // eslint-disable-line @typescript-eslint/no-unsafe-call
}
void compileOnlyConstruction;

describe('CONTRACT: public client boundary', () => {
  it('does not export private HTTP constructors at runtime', () => {
    const root = jest.requireActual<typeof import('../index')>('../index');
    expect(root).not.toHaveProperty('createAbloHttpClient');
    expect(root).not.toHaveProperty('createHttpTransport');
  });
});
