/**
 * AI Model Catalog — single source of truth for available models.
 *
 * Ported from apps/web/src/lib/ai/core/models.ts. The Next.js-specific
 * env-var resolution (NEXT_PUBLIC_DEFAULT_MODEL) stays in apps/web —
 * packages/agent consumers supply their own default.
 */

/** Available model identifiers. */
export type ModelId =
  | 'sonnet'
  | 'openai'
  | 'gemini'
  | 'grok'
  | 'glm'
  | 'fugu-ultra';

/** Prompt variant controlling how slides are generated. */
export type PromptVariant = 'layer-api' | 'html';

/** Document prompt variant controlling how documents are generated. */
export type DocumentPromptVariant = 'doc-html' | 'doc-blocks';

export const VALID_MODEL_IDS: ReadonlySet<ModelId> = new Set<ModelId>([
  'sonnet',
  'openai',
  'gemini',
  'grok',
  'glm',
  'fugu-ultra',
]);
export const VALID_PROMPT_VARIANTS: ReadonlySet<PromptVariant> = new Set<PromptVariant>([
  'layer-api',
  'html',
]);

export function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && VALID_MODEL_IDS.has(value as ModelId);
}
export function isPromptVariant(value: unknown): value is PromptVariant {
  return typeof value === 'string' && VALID_PROMPT_VARIANTS.has(value as PromptVariant);
}

/** Model metadata. */
export type ModelProvider = 'anthropic' | 'google' | 'openai' | 'xai' | 'zai' | 'sakana';
export type ModelRoute = 'anthropic' | 'google' | 'openai' | 'xai' | 'bedrock' | 'gateway';
export type ModelCostTier = 'premium' | 'balanced';

/**
 * Where the model's inference is hosted, for data-residency policy.
 *
 * Enforced (not cosmetic): an org's residency policy filters which models it can
 * select. Claude is tagged `eu` because production routes it through Bedrock
 * cross-region EU; OpenAI/Google/xAI are US-hosted; GLM is China-hosted; Sakana
 * Fugu is Japan-hosted (and orchestrates a wider pool of expert models, so its
 * effective residency is broad — treat `jp` as the control plane, not a guarantee
 * that every sub-call stays in-region).
 */
export type ModelResidency = 'eu' | 'us' | 'cn' | 'jp' | 'global' | 'unknown';

/**
 * How the model is authenticated/billed through the AI Gateway.
 * - `byok`: we hold the provider key (existing Anthropic/OpenAI/Google/xAI contracts).
 * - `gateway-credits`: the gateway holds keys and bills us (experimental models).
 */
export type ModelBilling = 'byok' | 'gateway-credits';

export interface ModelConfig {
  id: ModelId;
  label: string;
  /** Provider/vendor shown in the product UI and usage records. */
  provider: ModelProvider;
  /** Runtime path used by the host app to instantiate the model. */
  route: ModelRoute;
  /**
   * Provider-native model id. For `route: 'gateway'` entries this is the gateway
   * slug (`<provider>/<model>`, e.g. `zai/glm-5.2`); for all other routes it is
   * the vendor model name (e.g. `claude-sonnet-4-6`).
   */
  modelName: string;
  /** Bedrock cross-region EU or in-region model ID, when this model can route through Bedrock. */
  bedrockModelName?: string;
  costTier: ModelCostTier;
  /** Inference hosting region, for residency policy enforcement. */
  residency: ModelResidency;
  /** Auth/billing mode through the gateway. */
  billing: ModelBilling;
  description: string;
}

/** All available models in picker order. */
export const MODELS: ModelConfig[] = [
  {
    id: 'sonnet',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    route: 'anthropic',
    modelName: 'claude-sonnet-4-6',
    bedrockModelName: 'eu.anthropic.claude-sonnet-4-6',
    costTier: 'balanced',
    residency: 'eu',
    billing: 'byok',
    description: 'Best default for slide generation and agentic editing.',
  },
  {
    id: 'openai',
    label: 'GPT-5.5',
    provider: 'openai',
    route: 'openai',
    modelName: 'gpt-5.5',
    costTier: 'premium',
    residency: 'us',
    billing: 'byok',
    description: 'OpenAI flagship model for complex reasoning and coding.',
  },
  {
    id: 'gemini',
    label: 'Gemini 3.5 Flash',
    provider: 'google',
    route: 'google',
    modelName: 'gemini-3.5-flash',
    costTier: 'balanced',
    residency: 'us',
    billing: 'byok',
    description: 'Stable Google frontier model for agentic and coding tasks.',
  },
  {
    id: 'grok',
    label: 'Grok 4.3',
    provider: 'xai',
    route: 'xai',
    modelName: 'grok-4.3',
    costTier: 'balanced',
    residency: 'us',
    billing: 'byok',
    description: 'xAI flagship model for tool calling, long context, and general chat.',
  },
  {
    id: 'glm',
    label: 'GLM 5.2',
    provider: 'zai',
    route: 'gateway',
    modelName: 'zai/glm-5.2',
    costTier: 'balanced',
    residency: 'cn',
    billing: 'gateway-credits',
    description: 'Z.ai frontier model — strong coding and long-horizon tasks with 1M-token context.',
  },
  {
    id: 'fugu-ultra',
    label: 'Sakana Fugu Ultra',
    provider: 'sakana',
    route: 'gateway',
    modelName: 'sakana/fugu-ultra',
    costTier: 'premium',
    residency: 'jp',
    billing: 'gateway-credits',
    description:
      'Sakana AI orchestration model — coordinates a deep pool of expert agents for maximum accuracy on multi-step tasks. Vision + tools + reasoning, 1M-token context.',
  },
];

/** Quick lookup by id. */
export const MODEL_BY_ID: Record<ModelId, ModelConfig> = Object.fromEntries(
  MODELS.map((m) => [m.id, m]),
) as Record<ModelId, ModelConfig>;

/** Get next model in cycle — used by UI for model switcher. */
export function getNextModel(current: ModelId): ModelId {
  const currentIndex = MODELS.findIndex((m) => m.id === current);
  const nextIndex = (currentIndex + 1) % MODELS.length;
  return MODELS[nextIndex].id;
}
