/**
 * @ablo/agent/catalog/models — model catalog.
 *
 * Framework-agnostic metadata for the AI models we support. Env-var
 * defaults and provider factories live host-side (apps/web uses its own
 * wrapper; agent-worker has its own config).
 */

export {
  MODELS,
  MODEL_BY_ID,
  VALID_MODEL_IDS,
  VALID_PROMPT_VARIANTS,
  isModelId,
  isPromptVariant,
  getNextModel,
  type ModelId,
  type ModelConfig,
  type ModelCostTier,
  type ModelProvider,
  type ModelRoute,
  type ModelResidency,
  type ModelBilling,
  type PromptVariant,
  type DocumentPromptVariant,
} from './models';
