/**
 * CONTRACT — one typed update() shape across both public transports.
 *
 * Application code has one model door: `ablo.<model>`. Whether that client is
 * live WebSocket or stateless HTTP, `update` supports the same two forms:
 *
 *   - `update({ id, data }) -> T`
 *   - `update(id, current => next) -> T | undefined`
 *
 * The schema-agnostic HTTP protocol client is transport machinery and has its
 * own focused tests. It is deliberately not another public contract here.
 */

import { Ablo as createReactiveClient, type InternalAbloOptions } from '../../src/Ablo';
import { Ablo as createCoordinationClient } from '@abloatai/transaction';
import type {
  ModelOperations,
  ModelUpdateParams,
} from '../../src/local/client/createModelOperations';
import type { HttpModelClient } from '@abloatai/transaction/transport/http';
import type {
  ModelUpdater,
  FunctionalUpdateOptions,
} from '@abloatai/transaction/client/resources/functionalUpdate';
import type { CoordinatedModel } from '@abloatai/transaction/ai-sdk/coordinatedTool';
import { defineSchema, model, z } from '@abloatai/transaction/schema';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface Row {
  id: string;
  title: string;
}

interface RowCreate {
  title: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WsFunctionalParams = Expect<
  Equal<
    Parameters<ModelOperations<Row, RowCreate>['update']>,
    [id: string, updater: ModelUpdater<Row>, options?: FunctionalUpdateOptions]
  >
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WsFunctionalReturn = Expect<
  Equal<ReturnType<ModelOperations<Row, RowCreate>['update']>, Promise<Row | undefined>>
>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _HttpFunctionalParams = Expect<
  Equal<
    Parameters<HttpModelClient<Row, RowCreate>['update']>,
    [id: string, updater: ModelUpdater<Row>, options?: FunctionalUpdateOptions]
  >
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _HttpFunctionalReturn = Expect<
  Equal<ReturnType<HttpModelClient<Row, RowCreate>['update']>, Promise<Row | undefined>>
>;

// The flagship agent helper depends on the small shared model contract, never
// on either transport's larger client surface.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WsModelFitsCoordinatedTool = Expect<
  ModelOperations<Row, RowCreate> extends CoordinatedModel<Row> ? true : false
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _HttpModelFitsCoordinatedTool = Expect<
  HttpModelClient<Row, RowCreate> extends CoordinatedModel<Row> ? true : false
>;

function _compileOnlyUpdateProbes(
  wsModel: ModelOperations<Row, RowCreate>,
  httpModel: HttpModelClient<Row, RowCreate>,
): void {
  const wsObject: (params: ModelUpdateParams<Row>) => Promise<Row> = wsModel.update;
  const wsFunctional: (
    id: string,
    updater: ModelUpdater<Row>,
    options?: FunctionalUpdateOptions,
  ) => Promise<Row | undefined> = wsModel.update;

  const httpObject: (params: ModelUpdateParams<Row>) => Promise<Row> =
    httpModel.update;
  const httpFunctional: (
    id: string,
    updater: ModelUpdater<Row>,
    options?: FunctionalUpdateOptions,
  ) => Promise<Row | undefined> = httpModel.update;

  // @ts-expect-error — functional form requires an updater function
  void wsModel.update('id', { title: 'x' });
  // @ts-expect-error — functional form requires an updater function
  void httpModel.update('id', { title: 'x' });
  // @ts-expect-error — update always needs arguments
  void wsModel.update();

  void wsObject;
  void wsFunctional;
  void httpObject;
  void httpFunctional;
}
void _compileOnlyUpdateProbes;

const schema = defineSchema({
  items: model({ title: z.string() }, { typename: 'Item' }),
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('CONTRACT: coordination and reactive clients share one update shape', () => {
  it('exposes update on the typed coordination model', () => {
    const http = createCoordinationClient({
      schema,
      apiKey: 'sk_test_contract',
      baseURL: 'https://api.test',
      dangerouslyAllowBrowser: true,
      transport: 'http',
    });
    expect(typeof http.items.update).toBe('function');
    expect('model' in http).toBe(false);
  });

  it('exposes update on the typed reactive model', async () => {
    const stateful = createReactiveClient({
      schema,
      baseURL: 'ws://localhost:1234',
      user: { id: 'user-1' },
      inMemory: true,
      logger: silentLogger,
    } as InternalAbloOptions<(typeof schema)['models']>);
    try {
      expect(typeof stateful.items.update).toBe('function');
      expect('model' in stateful).toBe(false);
    } finally {
      await stateful.dispose();
    }
  });

  it('rejects a transport selector on the reactive materialiser', () => {
    expect(() => createReactiveClient({
      schema,
      apiKey: 'sk_test_contract',
      transport: 'http',
    })).toThrow('reactive client does not accept `transport`');
  });
});
