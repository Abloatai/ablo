/**
 * The logging port the SDK writes through.
 *
 * A contract with no framework and no local state: credential exchange, commit,
 * and claim all need to log with no UI and no offline store present, so the port
 * belongs to the settlement core (ADR 0016). The consumer supplies the
 * implementation; the SDK ships a no-op default.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** The no-op default — what the core logs through when no logger is wired. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
