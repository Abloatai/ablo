/**
 * The command registry's invariants.
 *
 * Handler parity is already a compile error — `HANDLERS` in `index.ts` is a
 * `Record<CommandName, …>`, so a command with no handler and a handler for no
 * command both fail to build. What the type system cannot say is whether a
 * reachable command is *documented*, which is the drift these tests exist to
 * stop: before the registry, `ablo schema` was dispatched and printed nowhere.
 */

import { COMMANDS, CORE_GROUPS, FULL_GROUPS, coreRows, fullRows, parseCommandName, suggestCommand, usageFor, type Command } from '../commands';

/** The registry at its declared type. `COMMANDS` keeps literal types, under
 *  which TypeScript can already prove some of these checks vacuous — reading it
 *  widened keeps them as runtime assertions that survive a later loosening. */
const ALL: readonly Command[] = COMMANDS;

describe('command registry', () => {
  it('renders a command\'s usage from the rows it already declares', () => {
    // The drift this closed: a module hand-wrote a usage block beside the rows
    // here, restating the same invocations with nothing keeping them agreeing.
    // Asserting containment pins the relationship rather than a copy of the
    // rendered output, which would be the self-pinning version of this test.
    let checked = 0;
    for (const command of COMMANDS) {
      if ('usage' in command) continue;
      if (!('full' in command)) continue;
      const usage = usageFor(command.name);
      expect(usage).toBeDefined();
      for (const row of command.full.rows) expect(usage).toContain(row.run);
      checked += 1;
    }
    // A guard on the guard: a loop over nothing would pass vacuously.
    expect(checked).toBeGreaterThan(3);
  });

  it('documents in its own help every flag the reference table lists', () => {
    // The hole this closes. A command that publishes prose opts out of the
    // derivation, so nothing had been checking the two against each other, and
    // `ablo push --help` could have lost `--force` while `ablo help --all` kept
    // advertising it.
    //
    // Coverage is the invariant, not spelling: the prose groups flags under
    // headings (`Safety:`) while a row writes them inline (`push --force`), and
    // both are right. So this matches the flag token exactly, which is a string
    // either present or absent, rather than guessing at two presentations of
    // the same line.
    const FLAG = /--[a-z][a-z0-9-]*/g;
    const undocumented: string[] = [];
    let checked = 0;
    for (const command of COMMANDS) {
      if (!('usage' in command)) continue;
      if (!('full' in command)) continue;
      const flags = new Set(command.full.rows.flatMap((row) => row.run.match(FLAG) ?? []));
      for (const flag of flags) {
        if (!command.usage.includes(flag)) undocumented.push(`${command.name} ${flag}`);
      }
      checked += 1;
    }
    expect(undocumented).toEqual([]);
    // A guard on the guard: a loop over nothing would pass vacuously.
    expect(checked).toBeGreaterThan(5);
  });

  it('lets a command keep its own usage when it publishes one', () => {
    // Some commands carry prose that rows cannot express; deriving over the top
    // of those would flatten `ablo connect --help` into a flag list.
    let checked = 0;
    for (const command of COMMANDS) {
      if (!('usage' in command)) continue;
      expect(usageFor(command.name)).toBe(command.usage);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('names each command once', () => {
    const names = ALL.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('documents every command, or marks it hidden on purpose', () => {
    // The invariant that makes absence meaningful: a command missing from the
    // help is missing because someone said so, not because it was forgotten.
    const undocumented = ALL.filter((c) => c.full === undefined && c.hidden === undefined).map((c) => c.name);
    expect(undocumented).toEqual([]);
  });

  it('keeps hidden commands out of both help texts', () => {
    const hidden = ALL.filter((c) => c.hidden === true).map((c) => c.name);
    expect(hidden).toContain('schema'); // the renamed `ablo schema push` shim
    const printed = [
      ...CORE_GROUPS.flatMap((g) => coreRows(g).map((r) => r.run)),
      ...FULL_GROUPS.flatMap((g) => fullRows(g).map((r) => r.run)),
    ];
    for (const name of hidden) {
      expect(printed.some((run) => run === name || run.startsWith(`${name} `))).toBe(false);
    }
  });

  it('shows every short-help command in the full help too', () => {
    // The short help is a curated subset, never a separate set of commands.
    const inCore = ALL.filter((c) => c.core !== undefined).map((c) => c.name);
    const inFull = new Set(ALL.filter((c) => c.full !== undefined).map((c) => c.name));
    for (const name of inCore) expect([...inFull]).toContain(name);
  });

  it('files every documented row under a declared heading', () => {
    // A row under a heading nobody renders would vanish silently.
    const rendered = FULL_GROUPS.reduce((n, g) => n + fullRows(g).length, 0);
    const declared = ALL.reduce((n, c) => n + (c.full?.rows.length ?? 0), 0);
    expect(rendered).toBe(declared);
  });

  it('resolves a real command and rejects anything else', () => {
    expect(parseCommandName('push')).toBe('push');
    expect(parseCommandName('schema')).toBe('schema'); // hidden, still reachable
    expect(parseCommandName('bogus')).toBeNull();
    expect(parseCommandName(undefined)).toBeNull();
  });
});

describe('suggestCommand — the answer an unrecognized command gets', () => {
  it('redirects a wrong-but-plausible name to its noun-verb command', () => {
    // Not typos: real intents whose command lives under `connect`. The
    // registry never grows a second name for the same operation; the
    // suggestion is a pointer, not an alias.
    expect(suggestCommand('disconnect')).toBe('connect deregister');
    expect(suggestCommand('deregister')).toBe('connect deregister');
    expect(suggestCommand('register')).toBe('connect register');
    expect(suggestCommand('rotate')).toBe('connect rotate');
  });

  it('lands a typo on the intended command — including a typo of a redirect', () => {
    expect(suggestCommand('stauts')).toBe('status');
    expect(suggestCommand('pussh')).toBe('push');
    // The doubled-letter typo that motivated this: `disconnnect` must reach
    // `connect deregister`, not whichever registry name is coincidentally near.
    expect(suggestCommand('disconnnect')).toBe('connect deregister');
  });

  it('offers nothing for a name near no command', () => {
    expect(suggestCommand('frobnicate')).toBeNull();
  });
});
