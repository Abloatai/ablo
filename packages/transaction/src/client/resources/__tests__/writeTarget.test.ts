/**
 * A per-model write names the row it acts on.
 *
 * These pin an outcome, not a spelling. The failure they close was that an
 * unaddressed `update` or `delete` produced an ordinary success receipt: the
 * id was interpolated into the URL, so `undefined` became the literal row name
 * `"undefined"`, the request matched nothing, and the caller was told it
 * worked. `delete({ where: { id } })` is the shape that walked into it, since
 * `where` is what the commit protocol takes one layer down.
 */
import { assertWriteTarget } from '../writeOptionsSchema.js';
import { resolveCreateId } from '../modelCreate.js';
import { AbloValidationError } from '../../../errors.js';

describe('assertWriteTarget', () => {
  it('accepts a write that names its row', () => {
    expect(() => assertWriteTarget('update', 'Issue', 'iss_1')).not.toThrow();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('refuses a write addressed by %s', (_label, id) => {
    expect(() => assertWriteTarget('delete', 'Issue', id)).toThrow(AbloValidationError);
  });

  it('points a `where` filter back at `id`, which is the shape that works', () => {
    expect(() => assertWriteTarget('delete', 'Issue', { where: { id: 'iss_1' } }))
      .toThrow(/delete\(\{ id \}\), not a `where` filter/);
  });

  it('names the model and the action, so the message locates the call', () => {
    expect(() => assertWriteTarget('update', 'Comment', undefined))
      .toThrow(/A Comment update has to name the row it acts on/);
  });
});

/**
 * A create honours the id it was given, in either documented spelling.
 *
 * The row used to be written under a generated id whenever the caller put
 * `id` inside `data`, which `InferCreate` explicitly permits. Nothing failed:
 * the create succeeded and returned a row the caller had not named.
 */
describe('resolveCreateId', () => {
  it('takes the sibling id', () => {
    expect(resolveCreateId('iss_1', { title: 'x' })).toBe('iss_1');
  });

  it('takes an id written inside `data`, which the create input allows', () => {
    expect(resolveCreateId(undefined, { id: 'iss_1', title: 'x' })).toBe('iss_1');
  });

  it('prefers the sibling when the two disagree', () => {
    expect(resolveCreateId('sibling', { id: 'in_data' })).toBe('sibling');
  });

  it('leaves the id to the client when neither names one', () => {
    expect(resolveCreateId(undefined, { title: 'x' })).toBeUndefined();
    expect(resolveCreateId(null, {})).toBeUndefined();
  });

  it('ignores an id that could not address a row', () => {
    expect(resolveCreateId('', { id: '' })).toBeUndefined();
    expect(resolveCreateId(undefined, { id: 42 })).toBeUndefined();
  });
});
