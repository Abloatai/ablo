/**
 * Isolated VM Executor
 *
 * Replaces Node.js `vm` module with `isolated-vm` for secure AI code execution.
 * Uses a separate V8 isolate with its own heap — prevents prototype chain escapes
 * that are possible with `vm.createContext`.
 *
 * Architecture:
 * - Plain data (slide, layers, constants) is copied into the isolate via ExternalCopy
 * - Sandbox methods are exposed via two dispatch callbacks (sync + async)
 * - D3 utilities run inside the isolate (pure computation, no I/O)
 * - PendingSlideAPI is proxied via a class defined inside the isolate
 */

import ivm from 'isolated-vm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MethodEntry {
  fn: (...args: unknown[]) => unknown;
  isAsync: boolean;
}

type MethodRegistry = Map<string, MethodEntry>;

interface RunInIsolateOptions {
  /** Memory limit in MB (default: 128) */
  memoryLimit?: number;
  /** Execution timeout in ms (default: 120_000) */
  timeout?: number;
  /**
   * Keys on the sandbox object to copy as plain data into the isolate.
   * These become `var <key> = ...` globals. Must be JSON-serializable.
   */
  dataKeys?: string[];
  /**
   * Keys to SKIP when auto-registering methods (e.g. keys that are data, not method namespaces).
   * Also used to skip keys that need special handling (like 'd3').
   */
  skipMethodKeys?: string[];
  /**
   * Raw JavaScript code to inject into the isolate before the user code runs.
   * Used for D3 utilities, content builders, or other pure-computation code
   * that should run inside the isolate rather than via callbacks.
   */
  injectCode?: string;
}

// ---------------------------------------------------------------------------
// Error Cause Description
// ---------------------------------------------------------------------------

/**
 * Pull the most useful diagnostic out of an error chain so it can be
 * appended to the wrapped dispatch error. Only `.message` survives the
 * structured clone across the isolate boundary, so without this the
 * caller sees `agent.run: fetch failed` and has no way to tell whether
 * it was DNS, connection refused, TLS, etc.
 *
 * Walks `.cause` (undici wraps the underlying SystemError there) and
 * reads `.code` first (machine-readable, e.g. ECONNREFUSED), falling
 * back to nested `.message`. Bounded depth so a circular cause chain
 * can't loop.
 */
function describeErrorCause(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  type WithCause = { cause?: unknown; code?: string; message?: string };
  let current: WithCause | undefined = err as WithCause;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current.code === 'string') return current.code;
    const next = current.cause;
    if (!next || typeof next !== 'object') {
      if (typeof current.message === 'string' && depth > 0) return current.message;
      return undefined;
    }
    current = next as WithCause;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Method Registry Builder
// ---------------------------------------------------------------------------

/**
 * Recursively walk an object and register all functions with dot-path keys.
 * Auto-detects async functions via constructor name.
 */
function buildMethodRegistry(
  obj: Record<string, unknown>,
  prefix: string,
  skipKeys: Set<string>
): MethodRegistry {
  const registry: MethodRegistry = new Map();

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    // Skip keys that are handled separately (data, d3, etc.)
    if (skipKeys.has(path)) continue;

    if (typeof value === 'function') {
      const isAsync = value.constructor.name === 'AsyncFunction';
      registry.set(path, { fn: value as MethodEntry['fn'], isAsync });
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !(value instanceof RegExp)
    ) {
      const nested = buildMethodRegistry(value as Record<string, unknown>, path, skipKeys);
      for (const [nestedPath, entry] of nested) {
        registry.set(nestedPath, entry);
      }
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Bootstrap Code Generator
// ---------------------------------------------------------------------------

/**
 * Generate JavaScript code that creates the sandbox API surface inside the isolate.
 * Groups methods by namespace and creates nested object literals.
 */
function generateBootstrapCode(registry: MethodRegistry, dataKeys: string[]): string {
  const lines: string[] = [];

  // 0. Install the namespace-access guard. Every namespace literal
  // generated below is wrapped with __nsGuard so unknown method
  // access (e.g. `deck.theme.getTokens()` when only `read`/`list`/...
  // exist) throws a helpful TypeError instead of `undefined is not a
  // function`. Symbol keys and the JS thenable-detection key `then`
  // pass through silently so Promise unwrapping and inspectors keep
  // working — only unknown string keys throw.
  lines.push(`
var __nsGuard = (function () {
  return function (path, target) {
    return new Proxy(target, {
      get: function (obj, key) {
        if (typeof key === 'symbol') return obj[key];
        if (key === 'then' && !(key in obj)) return undefined;
        if (key in obj) return obj[key];
        var available = Object.keys(obj).filter(function (k) {
          return typeof obj[k] === 'function' || (obj[k] && typeof obj[k] === 'object');
        });
        throw new TypeError(
          path + '.' + String(key) + ' does not exist. Available on ' + path + ': ' +
          (available.length ? available.join(', ') : '(none)')
        );
      },
      has: function (obj, key) { return key in obj; },
    });
  };
})();
`);

  // 1. Extract plain data from __data
  for (const key of dataKeys) {
    lines.push(`var ${key} = __data ? __data.${key} : undefined;`);
  }
  lines.push('');

  // 2. Collect top-level methods and namespaced methods
  const topLevel = new Map<string, boolean>(); // name → isAsync
  // namespace → (method → { isAsync, fullPath })
  const namespaces = new Map<string, Map<string, { isAsync: boolean; fullPath: string }>>();

  for (const [path, { isAsync }] of registry) {
    const parts = path.split('.');
    if (parts.length === 1) {
      topLevel.set(path, isAsync);
    } else {
      const ns = parts[0];
      const method = parts.slice(1).join('.');
      if (!namespaces.has(ns)) namespaces.set(ns, new Map());
      namespaces.get(ns)!.set(method, { isAsync, fullPath: path });
    }
  }

  // 3. Top-level function declarations
  for (const [name, isAsync] of topLevel) {
    if (isAsync) {
      lines.push(
        `var ${name} = function() { return __safeAsyncDispatch('${name}', Array.prototype.slice.call(arguments)); };`
      );
    } else {
      lines.push(
        `var ${name} = function() { return __safeSyncDispatch('${name}', Array.prototype.slice.call(arguments)); };`
      );
    }
  }
  lines.push('');

  // 4. Namespaced methods — handle up to 3 levels of nesting
  for (const [ns, methods] of namespaces) {
    const built = buildNestedObject(ns, methods);
    lines.push(built);
    lines.push('');
  }

  return lines.join('\n');
}

type MethodInfo = { isAsync: boolean; fullPath: string };
type MethodMap = Map<string, MethodInfo>;

/**
 * Recursively partition a flat method map by the FIRST dot-separated
 * segment. Returns `{ direct, nested }` where `direct` holds methods
 * whose remaining key has no dots (leaves at this level) and `nested`
 * groups everything else by their first segment.
 *
 * Used by `buildNestedObjectBody` below — splitting once per level
 * lets the function recurse cleanly on arbitrary depth.
 */
function partitionByFirstSegment(methods: MethodMap): {
  direct: MethodMap;
  nested: Map<string, MethodMap>;
} {
  const direct: MethodMap = new Map();
  const nested = new Map<string, MethodMap>();
  for (const [method, info] of methods) {
    const dotIdx = method.indexOf('.');
    if (dotIdx === -1) {
      direct.set(method, info);
    } else {
      const head = method.substring(0, dotIdx);
      const rest = method.substring(dotIdx + 1);
      if (!nested.has(head)) nested.set(head, new Map());
      nested.get(head)!.set(rest, info);
    }
  }
  return { direct, nested };
}

/**
 * Recursively render the body (without surrounding braces) of an
 * object literal whose keys are method names and whose values are
 * either dispatch functions or nested object literals.
 *
 * `indent` controls the leading whitespace per line so the emitted
 * code stays readable in error messages. Recursion handles arbitrary
 * depth — the previous hand-rolled 3-level version was the source of
 * the `layers.create:` invalid-key bug at depths 4+.
 */
function buildNestedObjectBody(methods: MethodMap, indent: string, path: string): string {
  const { direct, nested } = partitionByFirstSegment(methods);
  const lines: string[] = [];

  for (const [method, { isAsync, fullPath }] of direct) {
    const dispatch = isAsync ? '__safeAsyncDispatch' : '__safeSyncDispatch';
    lines.push(
      `${indent}${method}: function() { return ${dispatch}('${fullPath}', Array.prototype.slice.call(arguments)); }`,
    );
  }

  for (const [head, subMethods] of nested) {
    const subPath = path ? `${path}.${head}` : head;
    const inner = buildNestedObjectBody(subMethods, indent + '  ', subPath);
    // Wrap every nested namespace with __nsGuard so unknown method
    // access throws with the available method list — applied
    // uniformly at every depth so deck.theme.getTokens(),
    // deck.layouts.placeholders.unknownFn(), etc. all benefit.
    lines.push(`${indent}${head}: __nsGuard('${subPath}', {\n${inner}\n${indent}})`);
  }

  return lines.join(',\n');
}

/**
 * Build a nested object literal string for a namespace. Handles
 * arbitrarily deep sub-namespaces (e.g., `d3.scale.linear`,
 * `context.deck.layouts.layers.create`). The top-level namespace
 * itself is wrapped in __nsGuard so e.g. `deck.unknownThing` throws.
 */
function buildNestedObject(ns: string, methods: MethodMap): string {
  const body = buildNestedObjectBody(methods, '  ', ns);
  return `var ${ns} = __nsGuard('${ns}', {\n${body}\n});`;
}

// ---------------------------------------------------------------------------
// PendingSlide Proxy Bootstrap
// ---------------------------------------------------------------------------

/**
 * JavaScript code injected into the isolate to create the PendingSlide proxy.
 * When deck.createSlide() returns plain data from the host, the bootstrap
 * wraps it in this proxy class so `.createLayer()`, `.update()`, `.info()` work.
 */
const PENDING_SLIDE_PROXY_CODE = `
var __PendingSlideProxy = (function() {
  function PendingSlideProxy(data) {
    this.pendingId = data.pendingId;
    this.id = data.pendingId;
    this.position = data.position;
    this.slideNumber = data.slideNumber;
  }

  PendingSlideProxy.prototype.createLayer = function() {
    var args = [this.pendingId].concat(Array.prototype.slice.call(arguments));
    return __safeAsyncDispatch('__pendingSlide.createLayer', args);
  };

  PendingSlideProxy.prototype.update = function() {
    var args = [this.pendingId].concat(Array.prototype.slice.call(arguments));
    return __safeAsyncDispatch('__pendingSlide.update', args);
  };

  PendingSlideProxy.prototype.info = function() {
    return __safeSyncDispatch('__pendingSlide.info', [this.pendingId]);
  };

  return PendingSlideProxy;
})();
`;

// ---------------------------------------------------------------------------
// Main Executor
// ---------------------------------------------------------------------------

/**
 * Execute AI-generated code in an isolated V8 environment.
 *
 * @param code - The AI-generated JavaScript code to execute
 * @param sandbox - The sandbox object (same shape as built in route.ts)
 * @param options - Memory, timeout, and injection configuration
 * @returns The last expression value from the executed code
 */
export async function runInIsolatedVM(
  code: string,
  sandbox: Record<string, unknown>,
  options: RunInIsolateOptions = {}
): Promise<unknown> {
  const {
    memoryLimit = 128,
    timeout = 120_000,
    dataKeys = [],
    skipMethodKeys = [],
    injectCode,
  } = options;

  // Build skip set: data keys + explicitly skipped keys
  const skipSet = new Set([...dataKeys, ...skipMethodKeys]);

  // Build method registry from sandbox (auto-detects sync/async)
  const registry = buildMethodRegistry(sandbox, '', skipSet);

  // Extract plain data to copy into the isolate
  const plainData: Record<string, unknown> = {};
  for (const key of dataKeys) {
    const value = sandbox[key];
    if (value !== undefined) {
      try {
        // Ensure JSON-serializable (strips functions, circular refs)
        plainData[key] = JSON.parse(JSON.stringify(value));
      } catch {
        // Skip non-serializable values
      }
    }
  }

  // Create isolate with memory limit
  const isolate = new ivm.Isolate({ memoryLimit });

  try {
    const context = await isolate.createContext();
    const jail = context.global;

    // -- Inject plain data --
    if (Object.keys(plainData).length > 0) {
      jail.setSync('__data', new ivm.ExternalCopy(plainData).copyInto());
    }

    // -- Inject async dispatch --
    // NOTE: ivm.Callback with { async: true } is BROKEN in isolated-vm v6 —
    // it tries to structured-clone the Promise object instead of awaiting it.
    // Use ivm.Reference with .apply({ result: { promise: true, copy: true } }) instead.
    const asyncDispatchRef = new ivm.Reference(async (path: string, args: unknown[]) => {
      const entry = registry.get(path);
      if (!entry) throw new Error(`Unknown sandbox method: ${path}`);
      try {
        const result = await entry.fn(...(args || []));
        if (result === undefined) return null;
        // Copy-safe: strip functions and non-serializable values.
        // { copy: true } in the .apply() call handles the structured clone.
        return JSON.parse(JSON.stringify(result));
      } catch (err) {
        const msg = (err as Error).message || 'Sandbox method failed';
        // Log the FULL error (stack + .cause) so the staging logs show the
        // real reason (e.g. undici "fetch failed" carries cause as a
        // SystemError with `code: 'ENOTFOUND' | 'ECONNREFUSED' | ...`).
        // The thrown wrapper only carries `.message` because that's all
        // that survives the structured clone across the isolate boundary.
        console.error(`[ivm-dispatch] async ${path} failed:`, err);
        const causeMsg = describeErrorCause(err);
        throw new Error(causeMsg ? `${path}: ${msg} (${causeMsg})` : `${path}: ${msg}`);
      }
    });
    jail.setSync('__asyncDispatchRef', asyncDispatchRef);

    // -- Inject sync dispatch --
    jail.setSync(
      '__syncDispatch',
      new ivm.Callback((path: string, args: unknown[]) => {
        const entry = registry.get(path);
        if (!entry) throw new Error(`Unknown sandbox method: ${path}`);
        try {
          const result = entry.fn(...(args || []));
          if (result === undefined) return null;
          return JSON.parse(JSON.stringify(result));
        } catch (err) {
          const msg = (err as Error).message || 'Sandbox method failed';
          console.error(`[ivm-dispatch] sync ${path} failed:`, err);
          const causeMsg = describeErrorCause(err);
          throw new Error(causeMsg ? `${path}: ${msg} (${causeMsg})` : `${path}: ${msg}`);
        }
      })
    );

    // -- Inject console (for debugging) --
    jail.setSync(
      '__log',
      new ivm.Callback(
        (...logArgs: unknown[]) => {
          console.log('[Sandbox]', ...logArgs);
        },
        { ignored: true }
      )
    );

    // -- Inject result capture callback --
    // isolated-vm can't transfer Promises across the boundary, so async IIFE
    // return values are lost. We capture the result via a host callback instead.
    //
    // The __rejectResult callback runs synchronously from inside script.run,
    // before anyone has had a chance to attach a catch handler. Suppress the
    // unhandled-rejection warning with a no-op catch — the actual error still
    // propagates through `await resultPromise` later.
    let capturedResult: unknown = undefined;
    let capturedError: Error | null = null;
    const resultPromise = new Promise<void>((resolve, reject) => {
      jail.setSync(
        '__resolveResult',
        new ivm.Callback((result: unknown) => {
          capturedResult = result;
          resolve();
        })
      );
      jail.setSync(
        '__rejectResult',
        new ivm.Callback((message: string) => {
          capturedError = new Error(message);
          reject(capturedError);
        })
      );
    });
    resultPromise.catch(() => {});

    // -- Generate and run bootstrap --
    const bootstrapParts: string[] = [
      // Console shim
      'var console = { log: function() { __log.apply(null, Array.prototype.slice.call(arguments)); }, warn: function() { __log.apply(null, Array.prototype.slice.call(arguments)); }, error: function() { __log.apply(null, Array.prototype.slice.call(arguments)); } };',
      '',
      // Safe dispatch wrappers — catch clone errors with diagnostic info
      // Uses __asyncDispatchRef.apply() with { result: { promise: true } }
      // because ivm.Callback { async: true } is broken in isolated-vm v6.
      `var __safeAsyncDispatch = async function(path, args) {
  try {
    return await __asyncDispatchRef.apply(undefined, [path, args], { arguments: { copy: true }, result: { promise: true, copy: true } });
  } catch(e) {
    var argTypes = args.map(function(a) {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'object' && a.then) return 'Promise';
      if (typeof a === 'object' && a.constructor) return a.constructor.name;
      if (typeof a === 'function') return 'function';
      return typeof a;
    }).join(', ');
    console.error('[clone-error] ' + path + ' args=[' + argTypes + ']: ' + e.message);
    throw new Error('Failed to dispatch ' + path + ': ' + e.message + ' (arg types: ' + argTypes + ')');
  }
};
var __safeSyncDispatch = function(path, args) {
  try {
    return __syncDispatch(path, args);
  } catch(e) {
    var argTypes = args.map(function(a) {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'object' && a.constructor) return a.constructor.name;
      return typeof a;
    }).join(', ');
    console.error('[clone-error] ' + path + ' args=[' + argTypes + ']: ' + e.message);
    throw new Error('Failed to dispatch ' + path + ': ' + e.message + ' (arg types: ' + argTypes + ')');
  }
};`,
      '',
      // PendingSlide proxy class
      PENDING_SLIDE_PROXY_CODE,
      '',
      // Auto-generated API surface
      generateBootstrapCode(registry, dataKeys),
    ];

    // Wrap deck.slides.create/createSlide to return PendingSlideProxy instances
    bootstrapParts.push('');
    bootstrapParts.push(`
// Wrap deck.slides.create/createSlide if they exist — return PendingSlideProxy instead of plain data
// These are SYNC (uses __syncDispatch) — do NOT make them async!
// An async wrapper would return a Promise, and if AI code forgets to await it,
// the Promise gets passed as an arg to the next dispatch → "could not be cloned" error.
if (typeof deck !== 'undefined' && deck) {
  // Use 'in' (routes through nsGuard's has trap) rather than
  // property access (which routes through get and throws on
  // missing keys under nsGuard). Probing for optional methods at
  // bootstrap must be silent — only USER code accessing a missing
  // method should get a TypeError.
  if (typeof deck.slides !== 'undefined' && 'create' in deck.slides) {
    var __originalDeckCreate = deck.slides.create;
    deck.slides.create = function() {
      var data = __originalDeckCreate.apply(null, arguments);
      return new __PendingSlideProxy(data);
    };
  }
  if ('createSlide' in deck) {
    var __originalDeckCreateSlide = deck.createSlide;
    deck.createSlide = function() {
      var data = __originalDeckCreateSlide.apply(null, arguments);
      return new __PendingSlideProxy(data);
    };
  }
}
`);

    // Inject additional code (D3, content builders, etc.)
    if (injectCode) {
      bootstrapParts.push('');
      bootstrapParts.push(injectCode);
    }

    const bootstrap = bootstrapParts.join('\n');
    await context.eval(bootstrap, { timeout: 10_000 });

    // -- Run the AI-generated code --
    // Wrap in async IIFE with result capture via host callbacks.
    // isolated-vm can't transfer Promise values across the boundary,
    // so we resolve/reject via __resolveResult/__rejectResult callbacks.
    const wrappedCode = `
      (async () => {
        try {
          "use strict";
          var __result = await (async () => { "use strict"; ${code} })();
          // Sanitize result for transfer across isolate boundary.
          // Objects with functions, Promises, or other non-clonable values
          // would cause "could not be cloned" errors in structured clone.
          var __safe = __result;
          if (__result !== null && __result !== undefined && typeof __result === 'object') {
            try {
              __safe = JSON.parse(JSON.stringify(__result));
            } catch(e) {
              console.error('[resolve-result] Could not serialize result: ' + e.message);
              __safe = null;
            }
          }
          __resolveResult(__safe === undefined ? null : __safe);
        } catch (e) {
          __rejectResult(e && e.message ? e.message : String(e));
        }
      })();
    `;
    const script = await isolate.compileScript(wrappedCode, {
      filename: 'ai-generated-code.js',
    });

    // script.run() starts execution; resultPromise resolves when the async code completes.
    // The async IIFE yields on first await, so run() may resolve before the code finishes.
    // resultPromise captures the final result via __resolveResult/__rejectResult callbacks.
    //
    // We race full execution against a host-side timeoutPromise. The timer
    // is cleared in finally so the timeout never fires after the race
    // resolves — preventing unhandled-rejection noise.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Execution timed out after ${timeout}ms`)),
        timeout,
      );
    });
    // Suppress unhandled-rejection warning if the timer wins the race
    // before any other code attaches a catch handler.
    timeoutPromise.catch(() => {});

    const executionPromise = (async () => {
      await script.run(context, { timeout });
      await resultPromise;
    })();

    try {
      await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (capturedError) throw capturedError;
    return capturedResult;
  } finally {
    isolate.dispose();
  }
}

/**
 * Execute code in an isolated VM for slide file evaluation.
 * Simpler variant with no async dispatch needed — all methods are sync.
 *
 * @param code - The slide file code to evaluate
 * @param sandboxContext - Sync-only sandbox (content builders, Math, JSON, etc.)
 * @param options - Timeout configuration
 * @returns The result of the last expression in the code
 */
export function runInIsolatedVMSync(
  code: string,
  sandboxContext: Record<string, unknown>,
  options: { memoryLimit?: number; timeout?: number } = {}
): unknown {
  const { memoryLimit = 64, timeout = 5_000 } = options;

  const isolate = new ivm.Isolate({ memoryLimit });

  try {
    const context = isolate.createContextSync();
    const jail = context.global;

    // Inject sync dispatch for all methods
    const registry = buildMethodRegistry(sandboxContext, '', new Set());

    jail.setSync(
      '__syncDispatch',
      new ivm.Callback((path: string, args: unknown[]) => {
        const entry = registry.get(path);
        if (!entry) throw new Error(`Unknown method: ${path}`);
        const result = entry.fn(...(args || []));
        if (result === undefined) return null;
        return JSON.parse(JSON.stringify(result));
      })
    );

    // Inject plain data
    const dataKeys = Object.keys(sandboxContext).filter(
      (k) => typeof sandboxContext[k] !== 'function' && typeof sandboxContext[k] !== 'object'
    );
    const plainData: Record<string, unknown> = {};
    for (const key of dataKeys) {
      plainData[key] = sandboxContext[key];
    }

    // Inject standard globals that the code expects
    const objectData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sandboxContext)) {
      if (typeof value !== 'function' && typeof value === 'object' && value !== null) {
        try {
          objectData[key] = JSON.parse(JSON.stringify(value));
        } catch {
          // skip
        }
      }
    }

    if (Object.keys(plainData).length > 0 || Object.keys(objectData).length > 0) {
      jail.setSync('__data', new ivm.ExternalCopy({ ...plainData, ...objectData }).copyInto());
    }

    // Generate bootstrap for sync methods
    const syncBootstrap = generateBootstrapCode(registry, [
      ...Object.keys(plainData),
      ...Object.keys(objectData),
    ]);

    // Add standard globals (Math, JSON, etc.) — these exist natively in V8 isolates
    // so we don't need to inject them.

    context.evalSync(syncBootstrap, { timeout: 2_000 });

    // Run the code
    const result = context.evalSync(code, { timeout, filename: 'slide-file.ts' });
    return result;
  } finally {
    isolate.dispose();
  }
}
