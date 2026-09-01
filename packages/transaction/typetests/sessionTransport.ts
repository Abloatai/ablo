import { z } from 'zod';
import { Ablo } from '../src/client/ablo.js';
import { Sessions } from '../src/sessions/index.js';
import { defineSchema } from '../src/schema/schema.js';
import { model } from '../src/schema/model.js';

const schema = defineSchema({
  records: model({ status: z.string() }),
});

const schemaWithSessionsModel = defineSchema({
  sessions: model({ status: z.string() }),
});

const sessions = Sessions({ schema, apiKey: 'sk_test_control' });

async function sessionTransportSurface(): Promise<void> {
  const data = Ablo({ schema: schemaWithSessionsModel, apiKey: 'rk_test_agent' });
  await data.sessions.get({ id: 'session-row' });
  // @ts-expect-error Session issuance is owned by Sessions(), not a model client.
  data.sessions.handler;

  const boundedSession = await sessions.create({
    agent: { id: 'bounded-worker' },
    can: { records: ['read', 'update'] },
    groups: ['workspace:one'],
  });
  const bounded = Ablo({ schema, session: boundedSession });
  bounded.observe();
  await bounded.ready();

  const live = Ablo({
    schema,
    session: () => sessions.create({
      agent: { id: 'long-running-worker' },
      can: { records: ['read', 'update'] },
      groups: ['workspace:one'],
    }),
    groups: ['workspace:one'],
  });
  const subscription = await live.updateSubscription(['workspace:two']);
  const groups: string[] = subscription.groups;
  void groups;

  const browser = Ablo({
    schema,
    session: { endpoint: '/api/ablo-session', timeoutMs: 5_000 },
  });
  await browser.ready();

  // @ts-expect-error Public connection scope is `groups`; `syncGroups` is wire-only.
  Ablo({ schema, transport: 'websocket', syncGroups: ['workspace:one'] });
  // @ts-expect-error Browser mint routes live under `session.endpoint`.
  Ablo({ schema, authEndpoint: '/api/ablo-session' });
}

void sessionTransportSurface;
