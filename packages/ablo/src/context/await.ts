type Atomic = Date | RegExp | Error | ((...args: never[]) => unknown);

/** Recursively removes promises while preserving the caller's object shape. */
export type AwaitedDeep<T> =
  T extends PromiseLike<infer U> ? AwaitedDeep<U>
    : T extends Atomic ? T
      : T extends readonly unknown[] ? { [K in keyof T]: AwaitedDeep<T[K]> }
        : T extends object ? { [K in keyof T]: AwaitedDeep<T[K]> }
          : T;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function settle(value: unknown, active: WeakSet<object>): Promise<unknown> {
  const resolvedValue = await value;
  if (typeof resolvedValue !== 'object' || resolvedValue === null) return resolvedValue;
  if (!Array.isArray(resolvedValue) && !isPlainObject(resolvedValue)) return resolvedValue;
  if (active.has(resolvedValue)) return resolvedValue;

  active.add(resolvedValue);
  const entries = Array.isArray(resolvedValue)
    ? resolvedValue.map((item, index) => [index, item] as const)
    : Object.entries(resolvedValue);
  const resolvedEntries = await Promise.all(
    entries.map(async ([key, item]) => [key, await settle(item, active)] as const),
  );
  active.delete(resolvedValue);

  const changed = resolvedEntries.some(
    ([key, item]) => Reflect.get(resolvedValue, key) !== item,
  );
  if (!changed) return resolvedValue;
  if (Array.isArray(resolvedValue)) {
    const copy = [...resolvedValue];
    for (const [key, item] of resolvedEntries) copy[key as number] = item;
    return copy;
  }
  return Object.assign(
    Object.create(Object.getPrototypeOf(resolvedValue)),
    resolvedValue,
    Object.fromEntries(resolvedEntries),
  );
}

export async function awaitDeep<T>(value: T): Promise<AwaitedDeep<T>> {
  return await settle(value, new WeakSet()) as AwaitedDeep<T>;
}
