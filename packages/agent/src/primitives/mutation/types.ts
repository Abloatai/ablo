/**
 * Generic mutation shape used by the pipeline.
 *
 * Every mutation has at minimum a `type` ("create" | "update" | "delete")
 * and an `entityType` (e.g. "layer", "cell", "block"). Beyond that, the
 * shape is open — consumers (apps/web's RecordedMutation, agent-worker's
 * own type) extend this with discriminated-union payloads.
 *
 * The pure pipeline (recorder, parser, adapter interface, runner) only
 * touches these two fields. Adapters narrow to their richer types via
 * type guards.
 */
export interface Mutation {
  type: string;
  entityType: string;
  /** Open shape — adapters carry their own payloads. */
  [key: string]: unknown;
}
