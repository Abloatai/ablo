import type {
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider';
import type { WireClaim } from '@ablo/transaction/coordination';
import type { ClaimTarget } from '@ablo/transaction/types/streams';

export type { ClaimTarget };

export interface CoordinationAgent {
  pendingClaims(entityType: string, entityId: string): Promise<WireClaim[]>;
}

export interface CoordinationContextMiddlewareOptions {
  readonly agent: CoordinationAgent | null;
  readonly target: ClaimTarget | null;
  readonly excludeClaimIds?: readonly string[];
}

export function coordinationContextMiddleware(
  options: CoordinationContextMiddlewareOptions,
): LanguageModelV3Middleware {
  const { agent, target } = options;
  const excluded = new Set(options.excludeClaimIds ?? []);

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      if (!agent || !target) return params;

      const claims = (await agent.pendingClaims(target.type, target.id)).filter(
        (claim) =>
          !excluded.has(claim.claimId) &&
          targetsOverlap(claim, target),
      );
      if (claims.length === 0) return params;

      return injectSystemNote(params, formatCoordinationNote(claims, target));
    },
  };
}

function targetsOverlap(claim: WireClaim, target: ClaimTarget): boolean {
  const claimFields = new Set(
    [...(claim.fields ?? []), ...(claim.field ? [claim.field] : [])].map(
      (field) => field.toLowerCase(),
    ),
  );
  const targetFields = [
    ...(target.fields ?? []),
    ...(target.field ? [target.field] : []),
  ].map((field) => field.toLowerCase());

  if (claimFields.size === 0 || targetFields.length === 0) return true;
  return targetFields.some((field) => claimFields.has(field));
}

function formatCoordinationNote(
  claims: readonly WireClaim[],
  target: ClaimTarget,
): string {
  const entityLabel = target.type.toLowerCase();
  if (claims.length === 1) {
    const description = claims[0]?.description ?? 'editing';
    return (
      `<multiplayer_context>\n` +
      `Another participant is currently editing this ${entityLabel}. ` +
      `Declared work: ${description}. ` +
      `Defer to their concurrent changes when reasonable, or make your work complementary. ` +
      `Avoid overwriting their in-flight edits.\n` +
      `</multiplayer_context>`
    );
  }

  const descriptions = Array.from(
    new Set(claims.map((claim) => claim.description).filter(Boolean)),
  ).join('; ');
  return (
    `<multiplayer_context>\n` +
    `${claims.length} other participants are currently editing this ${entityLabel}. ` +
    (descriptions ? `Declared work: ${descriptions}. ` : '') +
    `Coordinate with their in-flight work by deferring where reasonable or making your work complementary.\n` +
    `</multiplayer_context>`
  );
}

function injectSystemNote(
  params: { prompt: LanguageModelV3Prompt; [key: string]: unknown },
  note: string,
): typeof params {
  return {
    ...params,
    prompt: [...params.prompt, { role: 'system', content: note }],
  };
}
