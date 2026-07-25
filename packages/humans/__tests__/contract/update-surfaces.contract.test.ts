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

import { Ablo, type InternalAbloOptions } from '../../src/Ablo';
import type {
  ModelOperations,
  ModelUpdateParams,
} from '../../src/local/client/createModelProxy';
import type { HttpModelClient } from '@abloatai/transaction/transport/httpClient';
import type {
  ModelUpdater,
  ContentionOptions,
} from '@abloatai/transaction/resources/functionalUpdate';
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
    [id: string, updater: ModelUpdater<Row>, options?: ContentionOptions]
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
    [id: string, updater: ModelUpdater<Row>, options?: ContentionOptions]
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
    options?: ContentionOptions,
  ) => Promise<Row | undefined> = wsModel.update;

  const httpObject: (params: ModelUpdateParams<Row>) => Promise<Row> =
    httpModel.update;
  const httpFunctional: (
    id: string,
    updater: ModelUpdater<Row>,
    options?: ContentionOptions,
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
  tasks: model({ title: z.string() }, { typename: 'Task' }),
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('CONTRACT: update has one shape across both transports', () => {
  it('exposes update on the typed HTTP model', () => {
    const http = Ablo({
      schema,
      apiKey: 'sk_test_contract',
      baseURL: 'https://api.test',
      dangerouslyAllowBrowser: true,
      transport: 'http',
    });
    expect(typeof http.tasks.update).toBe('function');
    expect('model' in http).toBe(false);
  });

  it('exposes update on the typed WebSocket model', async () => {
    const stateful = Ablo({
      schema,
      baseURL: 'ws://localhost:1234',
      user: { id: 'user-1' },
      inMemory: true,
      logger: silentLogger,
    } as InternalAbloOptions<(typeof schema)['models']>);
    try {
      expect(typeof stateful.tasks.update).toBe('function');
      expect('model' in stateful).toBe(false);
    } finally {
      await stateful.dispose();
    }
  });
});
