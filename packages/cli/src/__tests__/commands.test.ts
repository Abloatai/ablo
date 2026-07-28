/**
 * The command registry's invariants.
 *
 * Handler parity is already a compile error — `HANDLERS` in `index.ts` is a
 * `Record<CommandName, …>`, so a command with no handler and a handler for no
 * command both fail to build. What the type system cannot say is whether a
 * reachable command is *documented*, which is the drift these tests exist to
 * stop: before the registry, `ablo schema` was dispatched and printed nowhere.
 */

import { COMMANDS, CORE_GROUPS, FULL_GROUPS, coreRows, fullRows, parseCommandName, suggestCommand, type Command } from '../commands';

/** The registry at its declared type. `COMMANDS` keeps literal types, under
 *  which TypeScript can already prove some of these checks vacuous — reading it
 *  widened keeps them as runtime assertions that survive a later loosening. */
const ALL: readonly Command[] = COMMANDS;

describe('command registry', () => {
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
