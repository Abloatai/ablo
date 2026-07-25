/**
 * Entity-scope sync-group minting speaks the wire dialect.
 *
 * The server validates inbound `update_subscription` groups against a
 * lowercase-only grammar (`syncGroupInputSchema`), and claim presence fans
 * out by exact group-string match between holder and subscriber. Both facts
 * make the minted string a wire contract:
 *
 *   1. it must pass the server grammar (a camelCase schema key like
 *      `slideLayers` is rejected as malformed — the whole subscription
 *      update is refused atomically), and
 *   2. every resolution path (schema-key scope object, entity ref) must
 *      produce the IDENTICAL string for the same row, or two peers pin
 *      different groups and never observe each other's claims.
 *
 * The canonical kind is the declared scope root when present, otherwise the
 * lowercased typename — the same token the commit plane and claim targets
 * use (`wireModel`).
 */

import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { syncGroupInputSchema } from '@abloatai/transaction/schema/roles';
import {
  resolveParticipantSyncGroups,
  syncGroupFromEntityRef,
} from '../participants.js';

const schema = defineSchema({
  slideLayers: model(
    { slideId: z.string(), type: z.string() },
    { typename: 'SlideLayer', tableName: 'slide_layers' }),
  slideDecks: model(
    { title: z.string() },
    {
      typename: 'SlideDeck',
      tableName: 'slide_decks',
      groups: { root: 'deck' },
    }),
});

describe('entity-scope sync-group minting', () => {
  it('mints the lowercased typename for a camelCase schema key, never the key itself', () => {
    const groups = resolveParticipantSyncGroups({ slideLayers: 'layer-1' }, schema);
    expect(groups).toEqual(['slidelayer:layer-1']);
  });

  it('prefers a declared scope root over the typename', () => {
    const groups = resolveParticipantSyncGroups({ slideDecks: 'deck-1' }, schema);
    expect(groups).toEqual(['deck:deck-1']);
  });

  it('resolves the entity-ref form to the same string as the schema-key form', () => {
    const fromKey = resolveParticipantSyncGroups({ slideLayers: 'layer-1' }, schema);
    const fromTypename = syncGroupFromEntityRef({ type: 'SlideLayer', id: 'layer-1' }, schema);
    const fromKeyAsType = syncGroupFromEntityRef({ type: 'slideLayers', id: 'layer-1' }, schema);
    expect(fromTypename).toBe(fromKey[0]);
    expect(fromKeyAsType).toBe(fromKey[0]);
  });

  it('lowercases the fallback when the key is not in the schema', () => {
    const groups = resolveParticipantSyncGroups({ customThing: 'x-1' }, schema);
    expect(groups).toEqual(['customthing:x-1']);
  });

  it('every minted group passes the server-side group grammar', () => {
    const minted = [
      ...resolveParticipantSyncGroups({ slideLayers: 'layer-1' }, schema),
      ...resolveParticipantSyncGroups({ slideDecks: 'deck-1' }, schema),
      ...resolveParticipantSyncGroups({ customThing: 'x-1' }, schema),
      syncGroupFromEntityRef({ type: 'SlideLayer', id: 'layer-1' }, schema),
      syncGroupFromEntityRef({ type: 'unregistered', id: 'u-1' }, schema),
    ];
    for (const group of minted) {
      expect(syncGroupInputSchema.safeParse(group).success).toBe(true);
    }
  });
});
