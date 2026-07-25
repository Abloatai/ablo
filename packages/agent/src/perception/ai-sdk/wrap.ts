import type {
  LanguageModelV3,
  LanguageModelV3Middleware,
} from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import {
  coordinationContextMiddleware,
  type CoordinationAgent,
  type ClaimTarget,
} from './coordinationContext.js';

export interface WrapWithMultiplayerOptions {
  readonly model: LanguageModelV3;
  readonly agent: CoordinationAgent | null;
  readonly target: ClaimTarget | null;
  readonly excludeClaimIds?: readonly string[];
  readonly extraMiddleware?: readonly LanguageModelV3Middleware[];
}

export function wrapWithMultiplayer(
  options: WrapWithMultiplayerOptions,
): ReturnType<typeof wrapLanguageModel> {
  return wrapLanguageModel({
    model: options.model,
    middleware: [
      coordinationContextMiddleware({
        agent: options.agent,
        target: options.target,
        excludeClaimIds: options.excludeClaimIds,
      }),
      ...(options.extraMiddleware ?? []),
    ],
  });
}
