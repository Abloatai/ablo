export interface LocalModel {
  readonly id: string;
  readonly modifiedProperties: ReadonlyMap<
    string,
    { old: unknown; new: unknown }
  >;
  getModelName(): string;
  getChanges(): Record<string, unknown>;
  toJSON(): Record<string, unknown>;
  capturePreviousValues(
    keys: Iterable<string>,
    options?: { fallbackToLive?: boolean },
  ): Record<string, unknown>;
  consumeModifiedFields(keys?: Iterable<string>): void;
}
