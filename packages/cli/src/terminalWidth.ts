/**
 * How wide the terminal is — the one place that read is made safe.
 *
 * `process.stdout.columns` is declared a plain `number`, but the property
 * belongs to a TTY: piped into a file, a pager, or a CI log there is no
 * terminal and the read is `undefined`. Taken at its declared word, the width
 * arithmetic below it yields NaN and the block a command was laying out loses
 * the measure it was trying to be read at. `Number.isFinite` is the test that
 * holds for the declared type and the runtime one alike. Callers say what to
 * assume when nothing is attached.
 */
export function terminalWidth(fallback: number): number {
  const { columns } = process.stdout;
  return Number.isFinite(columns) ? columns : fallback;
}
