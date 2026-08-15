/**
 * CONTRACT — `track` exists on both public transports, with one shape.
 *
 * A track declares what a caller is watching. It keeps no local copy of the
 * row, so it is not a reactive capability: an agent on the stateless client has
 * the same reason to register a durable premise as one on a live socket, and
 * `POST /v1/commits` accepts a track-only body from either. Pinning both
 * signatures here is what keeps the two per-model surfaces from drifting on it
 * again.
 */

import { Ablo, type InternalAbloOptions } from '../../src/Ablo';
import type { ModelOperations } from '../../src/local/client/createModelProxy';
import type { HttpModelClient } from '@abloatai/transaction/transport/httpClient';
import type {
  ModelTrackParams,
  ModelTrackResult,
} from '@abloatai/transaction/resources/modelOperations';
import { defineSchema, model, z } from '@abloatai/transaction/schema';
import type { Identical } from '../../src/local/testing/typeEquality';

type Expect<T extends true> = T;

interface Row {
  id: string;
  title: string;
}

interface RowCreate {
  title: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WsTrackParams = Expect<
  Identical<Parameters<ModelOperations<Row, RowCreate>['track']>, [params: ModelTrackParams]>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WsTrackReturn = Expect<
  Identical<ReturnType<ModelOperations<Row, RowCreate>['track']>, Promise<ModelTrackResult>>
>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _HttpTrackParams = Expect<
  Identical<Parameters<HttpModelClient<Row, RowCreate>['track']>, [params: ModelTrackParams]>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _HttpTrackReturn = Expect<
  Identical<ReturnType<HttpModelClient<Row, RowCreate>['track']>, Promise<ModelTrackResult>>
>;

function _compileOnlyTrackProbes(
  wsModel: ModelOperations<Row, RowCreate>,
  httpModel: HttpModelClient<Row, RowCreate>,
): void {
  void wsModel.track({ id: 'row_1' });
  void httpModel.track({ id: 'row_1' });
  void wsModel.track({ id: 'row_1', readAt: 42 });
  void httpModel.track({ id: 'row_1', readAt: 42 });

  // @ts-expect-error — a track names the row it watches
  void httpModel.track({});
  // @ts-expect-error — a track names the row it watches
  void wsModel.track({});
}
void _compileOnlyTrackProbes;

const schema = defineSchema({
  items: model({ title: z.string() }, { typename: 'Item' }),
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('CONTRACT: track has one shape across both transports', () => {
  it('exposes track on the typed HTTP model', () => {
    const http = Ablo({
      schema,
      apiKey: 'sk_test_contract',
      baseURL: 'https://api.test',
      dangerouslyAllowBrowser: true,
      transport: 'http',
    });
    expect(typeof http.items.track).toBe('function');
  });

  it('exposes track on the typed WebSocket model', async () => {
    const stateful = Ablo({
      schema,
      baseURL: 'ws://localhost:1234',
      user: { id: 'user-1' },
      inMemory: true,
      logger: silentLogger,
    } as InternalAbloOptions<(typeof schema)['models']>);
    try {
      expect(typeof stateful.items.track).toBe('function');
    } finally {
      await stateful.dispose();
    }
  });
});
