import { describe, expect, it, vi } from 'vitest';
import type { Claim } from '@abloatai/transaction/types/streams';
import {
  Agent,
  AgentPerceptionUnavailableError,
  transactionPerceptionSource,
  type AgentPerceptionSource,
  type TransactionPerceptionModel,
} from './Agent.js';

function observedClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    object: 'claim',
    id: 'claim-1',
    target: { type: 'Slide', id: 'slide-1' },
    description: 'editing the title',
    heldBy: 'agent:other',
    ...overrides,
  };
}

function source(
  overrides: Partial<AgentPerceptionSource> = {},
): AgentPerceptionSource {
  return {
    get: async () => ({
      id: 'slide-1',
      updatedAt: '2026-07-26T08:00:00.000Z',
      updatedBy: 'agent:other',
    }),
    claims: async () => [],
    ...overrides,
  };
}

describe('Agent perception', () => {
  it('reads authoritative rows and canonical claim state through one adapter', async () => {
    const active = observedClaim();
    const queued = observedClaim({
      id: 'claim-2',
      status: 'queued',
      heldBy: 'agent:queued',
    });
    const model: TransactionPerceptionModel = {
      get: vi.fn(async () => ({ id: 'slide-1' })),
      claim: {
        state: vi.fn(async () => active),
        queue: vi.fn(async () => ({ data: [queued] })),
      },
    };
    const adapter = transactionPerceptionSource((type) =>
      type === 'Slide' ? model : undefined,
    );

    await expect(adapter.get('Slide', 'slide-1')).resolves.toEqual({
      id: 'slide-1',
    });
    await expect(adapter.claims('Slide', 'slide-1')).resolves.toEqual([
      active,
      queued,
    ]);
  });

  it('fails closed when an entity type has no transaction model', async () => {
    const adapter = transactionPerceptionSource(() => undefined);
    await expect(adapter.get('Unknown', 'row-1')).rejects.toBeInstanceOf(
      AgentPerceptionUnavailableError,
    );
  });

  it('marks a row stale when the authoritative version is newer', async () => {
    const perception = new Agent({
      agentId: 'reviewer',
      source: source(),
    });

    await expect(
      perception.checkFreshness(
        'Slide',
        'slide-1',
        Date.parse('2026-07-26T07:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      stale: true,
      reason: 'modified',
      lastModifiedBy: 'agent:other',
    });
  });

  it('does not turn failed reads into permission to write', async () => {
    const perception = new Agent({
      agentId: 'reviewer',
      source: source({
        get: async () => {
          throw new Error('credential expired');
        },
      }),
    });

    await expect(
      perception.checkFreshness('Slide', 'slide-1', Date.now()),
    ).rejects.toMatchObject({
      code: 'agent_perception_unavailable',
    });
  });

  it('reports unknown freshness as an error instead of a fresh result', async () => {
    const perception = new Agent({
      agentId: 'reviewer',
      source: source({
        claims: async () => {
          throw new Error('claims unavailable');
        },
      }),
    });
    await expect(
      perception.checkFreshness('Slide', 'slide-1', Date.now() - 1_000),
    ).rejects.toBeInstanceOf(AgentPerceptionUnavailableError);
  });

  it('injects only explicitly focused durable coordination context', async () => {
    const perception = new Agent({
      agentId: 'reviewer',
      source: source({ claims: async () => [observedClaim()] }),
    });
    const prepareStep = perception.prepareStep({
      focusFromToolCalls: (call) =>
        call.toolName === 'updateSlide' ? ['Slide:slide-1'] : undefined,
    });

    await expect(
      prepareStep({
        stepNumber: 1,
        steps: [{ toolCalls: [{ toolName: 'updateSlide' }] }],
        messages: [{ role: 'user', content: 'Update it' }],
      }),
    ).resolves.toMatchObject({
      messages: [
        { role: 'user' },
        { role: 'system', content: expect.stringContaining('Slide:slide-1') },
      ],
    });
  });

  it('uses live presence only when a human-facing announcer is injected', async () => {
    const announce = vi.fn(async () => {});
    const perception = new Agent({
      agentId: 'reviewer',
      source: source(),
      announcer: { announce },
    });

    await perception.announce('online', {
      entityType: 'Slide',
      entityId: 'slide-1',
      action: 'editing',
    });
    expect(announce).toHaveBeenCalledOnce();
  });
});
