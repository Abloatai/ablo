/**
 * Coordination authoring helpers — composable disposition fns + the `cn`-style
 * `coordination()` combinator that merges them into a serializable ConflictAxis.
 */

import {
  coordination,
  humansOverwrite,
  agentsReject,
  agentsNotify,
  systemReject,
} from '../index.js';

describe('coordination()', () => {
  it('merges disposition helpers into a per-committer-kind axis', () => {
    expect(coordination(humansOverwrite(), agentsReject())).toEqual({
      user: 'overwrite',
      agent: 'reject',
    });
  });

  it('the slides stance reads "humans overwrite, agents reject"', () => {
    expect(coordination(humansOverwrite(), agentsReject())).toEqual({
      user: 'overwrite',
      agent: 'reject',
    });
  });

  it('composes three actors', () => {
    expect(coordination(humansOverwrite(), agentsNotify(), systemReject())).toEqual({
      user: 'overwrite',
      agent: 'notify',
      system: 'reject',
    });
  });

  it('later rules win on a key collision (cn/cx semantics)', () => {
    expect(coordination(agentsReject(), agentsNotify())).toEqual({ agent: 'notify' });
  });

  it('no rules → empty axis (every kind falls to the engine default)', () => {
    expect(coordination()).toEqual({});
  });
});

// A chained axis is compared with `toEqual`, which weighs own enumerable
// properties and ignores the prototype — so these assert the dispositions the
// axis carries, exactly as the wire and the merge form see them, while the
// chaining methods it inherits stay out of the comparison.
describe('coordination.<rule>() chains', () => {
  it('reaches the same axis as the merge form', () => {
    expect(coordination.humansOverwrite().agentsReject()).toEqual(
      coordination(humansOverwrite(), agentsReject())
    );
  });

  it('composes three actors', () => {
    expect(coordination.humansOverwrite().agentsNotify().systemReject()).toEqual({
      user: 'overwrite',
      agent: 'notify',
      system: 'reject',
    });
  });

  it('later rules win on a key collision, as in the merge form', () => {
    expect(coordination.agentsReject().agentsNotify()).toEqual({ agent: 'notify' });
  });

  it('an unnamed kind stays absent rather than present-and-undefined, so it falls to the default', () => {
    expect(Object.keys(coordination.humansOverwrite())).toEqual(['user']);
  });

  it('serializes to the plain axis the server has always received', () => {
    expect(JSON.parse(JSON.stringify(coordination.humansOverwrite().agentsReject()))).toEqual({
      user: 'overwrite',
      agent: 'reject',
    });
  });

  it('each rule yields a fresh axis, so a shared base cannot be mutated by a branch', () => {
    const base = coordination.humansOverwrite();
    const rejecting = base.agentsReject();
    const notifying = base.agentsNotify();
    expect(Object.keys(base)).toEqual(['user']);
    expect(rejecting).toEqual({ user: 'overwrite', agent: 'reject' });
    expect(notifying).toEqual({ user: 'overwrite', agent: 'notify' });
  });
});
