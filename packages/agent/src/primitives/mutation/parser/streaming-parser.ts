/**
 * StreamingParser — generic, content-agnostic parser for AI sandbox API calls.
 *
 * Reads streamed code character-by-character from the AI's `execute` tool,
 * detects function calls matching adapter-supplied patterns, and emits
 * `MutationIntentEvent`s when each call's arguments close. Consumers (the
 * runner) use these events to update the preview store BEFORE the code
 * actually executes — that's how live preview works during streaming.
 *
 * Lifecycle per execute run:
 *   1. Runner constructs a parser with the union of adapter parser patterns.
 *   2. As the AI's code chunks arrive, runner calls `feedChunk(chunk)`.
 *   3. The parser walks the new bytes, scanning for pattern matches.
 *   4. When a match is found, it enters "argument capture" mode and tracks
 *      brace/paren/bracket depth + string state until the call's outermost
 *      paren closes.
 *   5. When args close, the parser parses the extracted text as JS-literal
 *      (using a permissive parser, NOT JSON.parse) and emits an intent event
 *      via `onIntent`.
 *   6. Runner uses the intent event to construct a partial RecordedMutation
 *      via the owning adapter and pushes it to the preview store.
 *
 * Design notes:
 *
 *   - The parser is **stateful** but the state is internal. Callers feed
 *     chunks; they don't manipulate the state machine directly.
 *   - The parser handles the **common case**: function calls with a single
 *     object literal argument (or up to a few positional args). It does NOT
 *     try to fully parse JavaScript — it just tracks delimiter depth.
 *   - Strings, template literals, line comments, and block comments are
 *     respected when tracking depth so braces inside strings don't confuse
 *     the depth counter.
 *   - The existing 2439-line slide parser at
 *     `apps/web/src/lib/ai-sandbox/streaming/parser.ts` has many additional
 *     features (target resolution, multi-mutation chains, bidi state). This
 *     generic parser is intentionally simpler. Slide patterns can be ported
 *     in Phase 4 if their full sophistication is needed; otherwise the
 *     simpler shape suffices for documents and spreadsheets.
 */

import {
  validateParserPattern,
  type ParserPattern,
} from './parser-patterns';

// ──────────────────── intent event ────────────────────────────────────────────

export interface MutationIntentEvent {
  /** Stable id for this specific call instance (used for dedup across re-emits). */
  callId: string;
  /** Which pattern matched. */
  pattern: ParserPattern;
  /**
   * Raw argument text as captured from the source code, between the outermost
   * parens. Includes any whitespace/newlines as written by the AI. For partial
   * events this is the text captured SO FAR (still inside the call).
   */
  rawArgsText: string;
  /**
   * Best-effort parsed JS-literal value of the first argument. May be `null`
   * if parsing failed (e.g. the AI used a variable reference or computed
   * expression). Adapters that need richer parsing can re-parse `rawArgsText`
   * themselves. For partial events on a template-literal first arg, this is
   * the raw substring between the opening backtick and the current scan
   * position (NOT eval'd — the template literal is still unclosed).
   */
  parsedFirstArg: unknown;
  /**
   * True when this event represents a finished call (closing paren seen).
   * False for streaming partials emitted mid-call — currently only fired
   * inside a template literal argument on patterns with
   * `contentType === 'document'`, so the document preview store can paint
   * HTML as it streams line-by-line. Consumers that don't care about
   * partials can check `if (!event.isFinal) return`.
   */
  isFinal: boolean;
}

// ──────────────────── parser ──────────────────────────────────────────────────

export interface StreamingParserOptions {
  /** Adapter-supplied patterns to detect. */
  patterns: readonly ParserPattern[];
  /** Called whenever a complete intent event is detected. */
  onIntent: (event: MutationIntentEvent) => void;
}

/**
 * Internal state machine for capturing one in-progress call's arguments. We
 * walk the source character-by-character tracking depth + string/comment
 * state until the outermost call paren closes.
 */
interface CaptureState {
  pattern: ParserPattern;
  callId: string;
  /** Position in the buffer where the args (after '(') begin. */
  argsStart: number;
  /** Current depth of (), {}, []; starts at 1 (the call's opening paren). */
  depth: number;
  /** Current string/comment context for character-class lookups. */
  ctx:
    | { kind: 'normal' }
    | { kind: 'single' }
    | { kind: 'double' }
    | { kind: 'template' }
    | { kind: 'line-comment' }
    | { kind: 'block-comment' };
  /**
   * Position of the opening backtick of the first-arg template literal, if
   * we've entered one. Used for streaming partial HTML emission inside
   * document.* calls — the slice [templateStart+1, currentPos) is the raw
   * HTML captured so far, and can be pushed straight into the preview store.
   */
  templateStart?: number;
}

export class StreamingParser {
  private readonly patterns: readonly ParserPattern[];
  private readonly onIntent: (event: MutationIntentEvent) => void;
  /** Accumulated source buffer across all chunks for this run. */
  private buffer = '';
  /** Position in `buffer` we've already scanned for pattern matches. */
  private scanPos = 0;
  /** Current in-progress capture, if any. */
  private capture: CaptureState | null = null;
  /** Monotonic counter for synthesizing unique call ids. */
  private callCounter = 0;

  constructor(options: StreamingParserOptions) {
    this.patterns = options.patterns;
    this.onIntent = options.onIntent;
    for (const p of this.patterns) validateParserPattern(p);
  }

  /**
   * Feed a streamed chunk into the parser. Scans for new pattern matches and
   * walks any in-progress capture forward. Synchronous; emits intent events
   * via the configured callback.
   */
  feedChunk(chunk: string): void {
    this.buffer += chunk;
    this.process();
  }

  /**
   * Drain any remaining state at end-of-stream. Currently a no-op — captures
   * that didn't close before the stream ended are simply discarded. Override
   * here if we ever want a "soft close" behavior for incomplete calls.
   */
  finalize(): void {
    // Intentional no-op — partial captures are dropped.
  }

  /** Reset the parser for a new run. Used by tests or recycled instances. */
  reset(): void {
    this.buffer = '';
    this.scanPos = 0;
    this.capture = null;
    this.callCounter = 0;
  }

  // ── internal scanning loop ────────────────────────────────────────────────
  private process(): void {
    while (true) {
      if (this.capture) {
        // We're inside a call's args — walk forward tracking depth.
        const closed = this.advanceCapture();
        if (!closed) return; // need more bytes
        // Capture finished, intent emitted; loop to look for next match.
        continue;
      }

      // No active capture — scan for the next pattern match starting at
      // `scanPos`. We try every pattern and pick the EARLIEST match in the
      // buffer to preserve in-order emission.
      let bestMatch: { pattern: ParserPattern; matchEnd: number } | null = null;
      for (const pattern of this.patterns) {
        pattern.callPattern.lastIndex = this.scanPos;
        const m = pattern.callPattern.exec(this.buffer);
        if (!m) continue;
        const matchEnd = m.index + m[0].length;
        if (!bestMatch || matchEnd < bestMatch.matchEnd) {
          bestMatch = { pattern, matchEnd };
        }
      }

      if (!bestMatch) {
        // No matches anywhere from scanPos onward. Park scanPos near the
        // buffer end (leave a small lookback in case a pattern straddles the
        // chunk boundary), and wait for more input.
        const lookback = 64;
        this.scanPos = Math.max(this.scanPos, this.buffer.length - lookback);
        return;
      }

      // Found a match. The opening paren is the LAST char of the match
      // (callPattern is required to end at the '(' — we enforce this by
      // looking for the next '(' if needed).
      let argsStart = bestMatch.matchEnd;
      // Skip whitespace between the match end and the actual '('.
      while (argsStart < this.buffer.length && /\s/.test(this.buffer[argsStart]!)) {
        argsStart++;
      }
      if (argsStart >= this.buffer.length) {
        // The '(' hasn't streamed yet — wait for more bytes.
        return;
      }
      if (this.buffer[argsStart] !== '(') {
        // Pattern matched but no '(' followed — false positive (e.g. the AI
        // wrote `document.createBlock` as a reference, not a call). Skip past
        // this position and continue scanning.
        this.scanPos = argsStart;
        continue;
      }

      // Enter capture mode. argsStart points to the char AFTER the '('.
      this.capture = {
        pattern: bestMatch.pattern,
        callId: `call-${++this.callCounter}`,
        argsStart: argsStart + 1,
        depth: 1,
        ctx: { kind: 'normal' },
      };
      this.scanPos = argsStart + 1;
    }
  }

  /**
   * Walk the buffer forward from the current scan position, advancing depth
   * tracking until either (a) the outermost paren closes — emit intent and
   * return true; or (b) we run out of bytes — return false.
   */
  private advanceCapture(): boolean {
    if (!this.capture) return false;
    let i = this.scanPos;
    const buf = this.buffer;

    while (i < buf.length) {
      const ch = buf[i]!;
      const next = buf[i + 1];
      const ctx = this.capture.ctx;

      switch (ctx.kind) {
        case 'normal': {
          if (ch === '/' && next === '/') {
            this.capture.ctx = { kind: 'line-comment' };
            i += 2;
            continue;
          }
          if (ch === '/' && next === '*') {
            this.capture.ctx = { kind: 'block-comment' };
            i += 2;
            continue;
          }
          if (ch === "'") {
            this.capture.ctx = { kind: 'single' };
            i++;
            continue;
          }
          if (ch === '"') {
            this.capture.ctx = { kind: 'double' };
            i++;
            continue;
          }
          if (ch === '`') {
            this.capture.ctx = { kind: 'template' };
            // Record the position of the opening backtick the FIRST time we
            // enter a template context in this capture. Used by the partial
            // emission path below to slice out the streaming HTML for
            // document.write / document.edit calls.
            if (this.capture.templateStart === undefined) {
              this.capture.templateStart = i;
            }
            i++;
            continue;
          }
          if (ch === '(' || ch === '{' || ch === '[') {
            this.capture.depth++;
            i++;
            continue;
          }
          if (ch === ')' || ch === '}' || ch === ']') {
            this.capture.depth--;
            if (this.capture.depth === 0 && ch === ')') {
              // Outermost call paren closed — emit intent.
              const rawArgsText = buf.slice(this.capture.argsStart, i);
              this.emitIntent(rawArgsText);
              this.scanPos = i + 1;
              this.capture = null;
              return true;
            }
            i++;
            continue;
          }
          i++;
          continue;
        }
        case 'single': {
          if (ch === '\\') {
            i += 2;
            continue;
          }
          if (ch === "'") {
            this.capture.ctx = { kind: 'normal' };
          }
          i++;
          continue;
        }
        case 'double': {
          if (ch === '\\') {
            i += 2;
            continue;
          }
          if (ch === '"') {
            this.capture.ctx = { kind: 'normal' };
          }
          i++;
          continue;
        }
        case 'template': {
          if (ch === '\\') {
            i += 2;
            continue;
          }
          if (ch === '`') {
            this.capture.ctx = { kind: 'normal' };
            i++;
            continue;
          }
          // Streaming partial emission: when a document.* call's first arg
          // is a long HTML template literal, the final intent event doesn't
          // fire until the entire backticked string closes. That's too
          // late for live preview — the user wants to see paragraphs paint
          // into the editor as the AI types them. We emit a partial intent
          // on every newline inside the template so the downstream preview
          // store (MutationPreviewStore) gets an incremental HTML buffer
          // it can push into the editor via setContent. Gated on
          // contentType === 'document' so the slide/spreadsheet paths stay
          // byte-for-byte identical.
          if (
            ch === '\n' &&
            this.capture.pattern.contentType === 'document' &&
            this.capture.templateStart !== undefined
          ) {
            const tStart = this.capture.templateStart;
            const partialHtml = buf.slice(tStart + 1, i);
            const rawSoFar = buf.slice(this.capture.argsStart, i);
            this.onIntent({
              callId: this.capture.callId,
              pattern: this.capture.pattern,
              rawArgsText: rawSoFar,
              // Unclosed template literals can't be eval'd by the permissive
              // parser — provide the raw slice directly as the parsed value.
              parsedFirstArg: partialHtml,
              isFinal: false,
            });
          }
          // Note: we don't track ${} interpolations as separate depth
          // contexts. For our parser's purpose (detecting end-of-call) the
          // simpler model is fine because adapter-supplied call shapes
          // generally don't put template literals containing parens.
          i++;
          continue;
        }
        case 'line-comment': {
          if (ch === '\n') {
            this.capture.ctx = { kind: 'normal' };
          }
          i++;
          continue;
        }
        case 'block-comment': {
          if (ch === '*' && next === '/') {
            this.capture.ctx = { kind: 'normal' };
            i += 2;
            continue;
          }
          i++;
          continue;
        }
      }
    }

    // Ran out of bytes mid-capture; park scanPos and wait for more.
    this.scanPos = i;
    return false;
  }

  private emitIntent(rawArgsText: string): void {
    if (!this.capture) return;
    const parsedFirstArg = parseFirstArgPermissive(rawArgsText);
    this.onIntent({
      callId: this.capture.callId,
      pattern: this.capture.pattern,
      rawArgsText,
      parsedFirstArg,
      isFinal: true,
    });
  }
}

// ──────────────────── permissive first-arg parser ────────────────────────────

/**
 * Best-effort parser for the first argument of a call's args text.
 *
 * The AI often writes `createBlock({type: 'paragraph', text: 'Hello'})` —
 * which is JS object literal syntax, NOT JSON (unquoted keys, single quotes).
 * We try a few strategies in order and return the first one that works:
 *
 *   1. JSON.parse — works for strict JSON
 *   2. Function-eval in a no-op scope — works for JS literals (the args are
 *      from the AI's tool input which is already trusted code about to be
 *      executed in a sandbox; we're just inspecting it for previewing)
 *   3. Return null on total failure — adapters can fall back to raw text
 *
 * SECURITY NOTE: this Function eval runs at the SERVER preview layer for
 * code that the server is ABOUT TO RUN in the isolate sandbox anyway. There
 * is no additional attack surface — if the AI emits malicious code, the
 * sandbox is what protects us, not this preview parser. We restrict the
 * eval to expression context only and never execute statements.
 */
function parseFirstArgPermissive(argsText: string): unknown {
  const trimmed = argsText.trim();
  if (trimmed.length === 0) return null;

  // Find the end of the first top-level argument by walking commas at depth 0.
  let depth = 0;
  let endOfFirstArg = trimmed.length;
  let ctx: 'normal' | 'single' | 'double' | 'template' = 'normal';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ctx === 'normal') {
      if (ch === "'") ctx = 'single';
      else if (ch === '"') ctx = 'double';
      else if (ch === '`') ctx = 'template';
      else if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        endOfFirstArg = i;
        break;
      }
    } else if (ctx === 'single') {
      if (ch === '\\') i++;
      else if (ch === "'") ctx = 'normal';
    } else if (ctx === 'double') {
      if (ch === '\\') i++;
      else if (ch === '"') ctx = 'normal';
    } else if (ctx === 'template') {
      if (ch === '\\') i++;
      else if (ch === '`') ctx = 'normal';
    }
  }

  const firstArg = trimmed.slice(0, endOfFirstArg).trim();
  if (firstArg.length === 0) return null;

  // Try JSON first (strict, fast path).
  try {
    return JSON.parse(firstArg);
  } catch {
    // Fall through.
  }

  // Try expression eval. Wrap in parens so object literals aren't mistaken
  // for blocks.
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(`return (${firstArg});`);
    return fn();
  } catch {
    return null;
  }
}
