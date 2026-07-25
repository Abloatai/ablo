/**
 * The derivation is what makes a database connectable to more than one plane
 * (ADR 0020), so the properties that matter are: distinct planes never collide,
 * the SAME plane always derives the same names, and every derived name is one
 * Postgres will actually accept.
 */

import {
  footprintNamesFor,
  isValidReplicationSlotName,
  ABLO_FOOTPRINT,
  ABLO_REPLICATION_SLOT,
  type FootprintPlane,
  type FootprintArtifact,
} from '@ablo/transaction/footprint';

const ORG = 'org_2b8f1c';
const base: FootprintPlane = { organizationId: ORG, environment: 'production' };

describe('footprintNamesFor', () => {
  it('gives every object a name no other connection can claim', () => {
    const names = footprintNamesFor(base);
    const suffix = names.slot.replace(`${ABLO_REPLICATION_SLOT}_`, '');

    // One digest across all four, so a database's footprint reads as one set per
    // connection rather than a mix of shared and private objects.
    expect(names.publication.endsWith(suffix)).toBe(true);
    expect(names.replicationRole.endsWith(suffix)).toBe(true);
    expect(names.writeRole.endsWith(suffix)).toBe(true);
    expect(suffix).toHaveLength(16);
  });

  it('is stable, so re-running setup installs nothing a second time', () => {
    expect(footprintNamesFor(base)).toEqual(footprintNamesFor({ ...base }));
  });

  it('separates every plane axis — this is the collision the constants guaranteed', () => {
    const planes: FootprintPlane[] = [
      base,
      { ...base, environment: 'sandbox' },
      { ...base, projectId: 'proj_a' },
      { ...base, projectId: 'proj_b' },
      { ...base, projectId: 'proj_a', sandboxId: 'sbx_1' },
      { ...base, projectId: 'proj_a', sandboxId: 'sbx_2' },
      { ...base, organizationId: 'org_other' },
      { organizationId: 'org_other', environment: 'sandbox' },
    ];
    const slots = planes.map((p) => footprintNamesFor(p).slot);
    expect(new Set(slots).size).toBe(planes.length);
  });

  it('treats the organization-default project as ONE plane however it is spelled', () => {
    // A self-serve key stamps `projectId = organizationId`; the admin path omits
    // it. They are the same plane, and deriving two names for it would install a
    // second slot on the same database for the same connection.
    const stamped = footprintNamesFor({ ...base, projectId: ORG });
    const omitted = footprintNamesFor(base);
    const empty = footprintNamesFor({ ...base, projectId: '', sandboxId: '' });

    expect(stamped).toEqual(omitted);
    expect(empty).toEqual(omitted);
  });

  it('derives names Postgres accepts — lowercase, digits, underscore, under 63 bytes', () => {
    const long: FootprintPlane = {
      organizationId: 'org_' + 'x'.repeat(120),
      environment: 'sandbox',
      projectId: 'proj_' + 'y'.repeat(120),
      sandboxId: 'sbx_' + 'z'.repeat(120),
    };
    for (const plane of [base, long]) {
      const names = footprintNamesFor(plane);
      for (const name of Object.values(names) as string[]) {
        // The slot charset is the strictest of the four; holding every name to
        // it keeps the set uniform and safely inside the identifier ceiling.
        expect(isValidReplicationSlotName(name)).toBe(true);
        expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
      }
    }
  });

  it('spreads across the digest space rather than clustering on a shared prefix', () => {
    // Sequential cuid-shaped ids share long prefixes; a weak digest would give
    // them neighbouring suffixes and eat the distinctness the length buys.
    const slots = Array.from({ length: 500 }, (_, i) =>
      footprintNamesFor({ ...base, projectId: `cmr1khsfgrwwhnkt${String(i).padStart(4, '0')}` }).slot,
    );
    expect(new Set(slots).size).toBe(500);
  });
});

describe('ABLO_FOOTPRINT', () => {
  it('declares every object with a purpose, since the audit reports it verbatim', () => {
    expect(ABLO_FOOTPRINT.length).toBeGreaterThan(0);
    for (const artifact of ABLO_FOOTPRINT) {
      expect(artifact.name).toMatch(/^[a-z0-9_]+$/);
      expect(artifact.purpose.length).toBeGreaterThan(0);
    }
  });

  it('names the slot hazard — the one object whose cost of being left falls on the customer', () => {
    const slot = ABLO_FOOTPRINT.find((a: FootprintArtifact) => a.name === ABLO_REPLICATION_SLOT);
    expect(slot?.hazard).toBeDefined();
    expect(ABLO_FOOTPRINT.filter((a: FootprintArtifact) => a.retired).length).toBeGreaterThan(0);
  });
});
