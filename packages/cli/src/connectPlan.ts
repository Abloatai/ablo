import pc from 'picocolors';
import type { ApplyStep } from '@abloatai/transaction/server/postgresSetup';

/** Print the plan as a short, scannable checklist — titles only, SQL only if asked. */
export function printPlan(steps: readonly ApplyStep[], showSql: boolean): void {
  console.log(`  This sets up your database for Ablo:\n`);
  for (const step of steps) {
    console.log(`    ${pc.green('•')} ${step.title}`);
    if (showSql) {
      for (const statement of step.sql) {
        for (const line of statement.split('\n')) console.log(`        ${pc.dim(line)}`);
      }
    }
  }
  console.log(
    pc.dim(
      `\n  Your admin password stays on this machine.${showSql ? '' : ' (--show-sql for the exact statements)'}\n`
    )
  );

  // Last, and unmissable: what this reaches beyond Ablo's own objects. Placed
  // after the plan so it is the final thing read before the confirmation.
  const reaching = steps.flatMap((step) => step.affectsOthers ?? []);
  if (reaching.length > 0) {
    console.log(`  ${pc.yellow('!')} This also changes things Ablo does not own:\n`);
    for (const effect of reaching) {
      for (const line of wrapToWidth(effect, 74)) console.log(`      ${line}`);
      console.log();
    }
  }
}

/** Wrap plain prose to a column so a multi-sentence notice stays readable in a terminal. */
function wrapToWidth(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
