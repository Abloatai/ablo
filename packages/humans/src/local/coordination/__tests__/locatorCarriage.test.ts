/**
 * Every member of the locator survives every hop that carries a claim — and
 * the three spellings of the entity half say the same thing.
 *
 * This is a gate on the property, not on the syntax that last broke it. The
 * locator used to be copied member by member at more than twenty sites, so
 * widening it reached none of them: `fields` was added to the schema and to the
 * conflict rule, and the request body and the server's claim construction both
 * dropped it, which made a set-scoped claim silently hold the whole row.
 *
 * The cases enumerate `targetRefSchema`'s own keys rather than a written-out
 * list, so a member added to the locator is covered here the moment it exists —
 * nobody has to remember to extend this file, which is the failure mode it
 * exists to catch.
 *
 * Two hops the first version of this file missed, both of which then broke:
 * CONSTRUCTION — the schemas were gated while `claim()` still spelled its
 * handle out by hand, so `fields` died between the caller and the socket with
 * every parse test passing; and the WAIT LINE, whose target was a hand-written
 * copy of the same locator and could not hold `fields` at all. Both are covered
 * below.
 */

import {
  targetRefSchema,
  claimBeginPayloadSchema,
  claimQueueEntrySchema,
  modelTargetSchema,
  presenceActivitySchema,
  subTarget,
  wireTarget,
  modelTarget,
  streamTarget,
} from '@abloatai/transaction/coordination';
import { claimRequestSchema } from '@abloatai/transaction/wire';
import { WsTransport } from '@abloatai/transaction/transport/wsTransport';
import {
  createClaimStream,
  type ClaimTransport,
} from '../../sync/createClaimStream.js';
import { createPresenceStream } from '../../../presenceStream.js';

/** The locator members below the entity — everything a claim can narrow by. */
const LOCATOR_MEMBERS = Object.keys(targetRefSchema.shape).filter(
  (key) => key !== 'entityType' && key !== 'entityId',
);

/** The entity half — the two members spelled differently on every surface. */
const ENTITY_MEMBERS = Object.keys(targetRefSchema.shape).filter(
  (key) => key === 'entityType' || key === 'entityId',
);

/** A representative value per member, so each can be sent and read back. */
const SAMPLE: Record<string, unknown> = {
  field: 'title',
  fields: ['b_1', 'b_2'],
  meta: { note: 'carried verbatim' },
};

/** One entity, in the wire's spelling. The other two derive from it. */
const ENTITY = { entityType: 'doc', entityId: 'd1' };

/** A whole target: the entity plus exactly one narrowing member. */
function targetWith(member: string): {
  readonly type: string;
  readonly id: string;
} & TargetSlice {
  return {
    ...streamTarget(ENTITY),
    ...subTarget({ [member]: SAMPLE[member] }),
  };
}

/** Records what a stream puts on the wire, without a socket. */
function recordingTransport(): ClaimTransport & {
  readonly sent: { type: string; payload?: Record<string, unknown> }[];
} {
  const sent: { type: string; payload?: Record<string, unknown> }[] = [];
  return {
    sent,
    subscribe: () => () => undefined,
    isConnected: () => true,
    send: (message: { type: string; payload?: Record<string, unknown> }) => {
      sent.push(message);
    },
  };
}

describe('the sub-entity locator survives every carrier', () => {
  it('the sample covers every member the locator declares', () => {
    // If this fails, a member was added to `targetRefSchema` and the sample
    // below has no value for it — the carriage cases would skip it silently.
    expect(Object.keys(SAMPLE).sort()).toEqual([...LOCATOR_MEMBERS].sort());
  });

  it('meta stays permissive on the wire while the read surface is typed', () => {
    // A program declares the shape of its claim metadata once, on `Register`,
    // and reads `target.meta` without a guard. That is a promise about what
    // this program writes — never a filter on what arrives. The parse has to
    // keep carrying a value it has never seen, or a newer peer's claim would
    // reach an older build stripped of the fields it coordinates on.
    const unforeseen = { blocks: 3, note: null, nested: { deep: [1, 2] } };

    expect(targetRefSchema.parse({ ...ENTITY, meta: unforeseen }).meta).toEqual(
      unforeseen,
    );

    const body = claimRequestSchema.parse({
      target: { model: 'doc', id: 'd1', meta: unforeseen },
    });
    expect(subTarget(body.target).meta).toEqual(unforeseen);
  });

  it.each(LOCATOR_MEMBERS)('the projection carries %s', (member) => {
    const projected = subTarget({ [member]: SAMPLE[member] });
    expect(projected[member as keyof typeof projected]).toEqual(SAMPLE[member]);
  });

  it.each(LOCATOR_MEMBERS)('the HTTP claim body carries %s', (member) => {
    const body = claimRequestSchema.parse({
      target: { model: 'doc', id: 'd1', [member]: SAMPLE[member] },
    });
    expect(subTarget(body.target)[member as keyof TargetSlice]).toEqual(
      SAMPLE[member],
    );
  });

  it.each(LOCATOR_MEMBERS)('the socket claim_begin frame carries %s', (member) => {
    const frame = claimBeginPayloadSchema.parse({
      claimId: 'c1',
      ...ENTITY,
      [member]: SAMPLE[member],
    });
    expect(subTarget(frame)[member as keyof TargetSlice]).toEqual(
      SAMPLE[member],
    );
  });

  it.each(LOCATOR_MEMBERS)('the wait-line entry carries %s', (member) => {
    // The entry's target was a hand-written copy of the locator, so zod struck
    // `fields` off every queue frame no matter what the server put in it.
    const entry = claimQueueEntrySchema.parse({
      object: 'claim',
      id: 'c1',
      status: 'queued',
      target: targetWith(member),
      position: 0,
      expiresAt: Date.now() + 60_000,
    });
    expect(subTarget(entry.target)[member as keyof TargetSlice]).toEqual(
      SAMPLE[member],
    );
  });

  it.each(LOCATOR_MEMBERS)('the presence activity frame carries %s', (member) => {
    const activity = presenceActivitySchema.parse({
      ...ENTITY,
      action: 'editing',
      [member]: SAMPLE[member],
    });
    expect(subTarget(activity)[member as keyof TargetSlice]).toEqual(
      SAMPLE[member],
    );
  });
});

describe('the locator survives construction, not only parsing', () => {
  it.each(LOCATOR_MEMBERS)(
    'the claim handle a caller reads back carries %s',
    (member) => {
      const stream = createClaimStream({ participantId: 'me' });
      const handle = stream.claim(targetWith(member));
      expect(subTarget(handle.target)[member as keyof TargetSlice]).toEqual(
        SAMPLE[member],
      );
    },
  );

  it.each(LOCATOR_MEMBERS)('claim() puts %s on the wire', (member) => {
    const transport = recordingTransport();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(transport);
    stream.claim(targetWith(member));

    const begin = transport.sent.find((m) => m.type === 'claim_begin');
    const payload = claimBeginPayloadSchema.parse(begin?.payload);
    expect(subTarget(payload)[member as keyof TargetSlice]).toEqual(
      SAMPLE[member],
    );
  });

  it.each(LOCATOR_MEMBERS)(
    'a presence verb announces %s about the entity it names',
    (member) => {
      const stream = createPresenceStream({
        participantId: 'me',
        syncGroups: [],
      });
      stream.editing(targetWith(member));
      expect(
        subTarget(stream.self.activity)[member as keyof TargetSlice],
      ).toEqual(SAMPLE[member]);
    },
  );
});

describe('the locator survives the hops that build a frame, not only the ones that parse it', () => {
  it.each(LOCATOR_MEMBERS)(
    'the model surface\'s spelling reaches the socket carrying %s',
    (member) => {
      // What `ablo.<model>.claim.create({ target })` does: a target spelled in
      // the model vocabulary crosses to the claim stream through the two
      // projections. It used to cross member by member, which is where a field
      // set died between the caller and the wire. The reactive engine cannot be
      // assembled without a connection, so the hop is exercised here at the
      // stream it calls.
      const modelSpelled = {
        ...modelTarget(ENTITY),
        ...subTarget({ [member]: SAMPLE[member] }),
      };
      const transport = recordingTransport();
      const stream = createClaimStream({ participantId: 'me' });
      stream.attach(transport);
      stream.claim({
        ...streamTarget(modelSpelled),
        ...subTarget(modelSpelled),
      });

      const begin = transport.sent.find((m) => m.type === 'claim_begin');
      const payload = claimBeginPayloadSchema.parse(begin?.payload);
      expect(modelTarget(payload)).toEqual(modelTarget(ENTITY));
      expect(subTarget(payload)[member as keyof TargetSlice]).toEqual(
        SAMPLE[member],
      );
    },
  );

  it.each(LOCATOR_MEMBERS)(
    'a peer\'s activity read off the wire keeps %s',
    (member) => {
      // The INGEST side of presence. It rebuilt `Peer.activity` member by
      // member, so a set-scoped peer arrived announcing the whole row — 45
      // lines from the outbound path that had already been repaired.
      const transport = new WsTransport({ deferConnect: true });
      const stream = createPresenceStream({
        participantId: 'me',
        syncGroups: [],
      });
      stream.attach(transport);

      transport.emit('presence_update', {
        kind: 'update',
        userId: 'peer-1',
        status: 'online',
        activity: presenceActivitySchema.parse({
          ...ENTITY,
          action: 'editing',
          [member]: SAMPLE[member],
        }),
      });

      const peer = stream.others[0];
      if (!peer) throw new Error('the presence frame never reached the roster');
      expect(wireTarget(peer.activity)).toEqual(ENTITY);
      expect(subTarget(peer.activity)[member as keyof TargetSlice]).toEqual(
        SAMPLE[member],
      );
    },
  );
});

describe('the three spellings of the entity half agree', () => {
  it('the two halves partition the locator', () => {
    // A member added to `targetRefSchema` lands in one set or the other, so it
    // can never be silently uncovered by both.
    expect([...LOCATOR_MEMBERS, ...ENTITY_MEMBERS].sort()).toEqual(
      Object.keys(targetRefSchema.shape).sort(),
    );
    expect(ENTITY_MEMBERS.sort()).toEqual(['entityId', 'entityType']);
  });

  it('every spelling reads back as every other', () => {
    const wire = wireTarget(ENTITY);
    const model = modelTarget(ENTITY);
    const stream = streamTarget(ENTITY);

    for (const source of [wire, model, stream]) {
      expect(wireTarget(source)).toEqual(wire);
      expect(modelTarget(source)).toEqual(model);
      expect(streamTarget(source)).toEqual(stream);
    }
  });

  it('each emitter satisfies the schema of the surface it fills', () => {
    // Checked against the definition sites rather than against a literal
    // written here, so a renamed member fails at the schema, not at the test.
    expect(targetRefSchema.parse(wireTarget(ENTITY))).toEqual(
      wireTarget(ENTITY),
    );
    expect(modelTargetSchema.parse(modelTarget(ENTITY))).toEqual(
      modelTarget(ENTITY),
    );
    expect(
      claimQueueEntrySchema.shape.target.parse(streamTarget(ENTITY)),
    ).toEqual(streamTarget(ENTITY));
  });
});

type TargetSlice = ReturnType<typeof subTarget>;
