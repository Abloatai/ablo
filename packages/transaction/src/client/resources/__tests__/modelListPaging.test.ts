/**
 * A model list read walks its own pages.
 *
 * The failure this closes was not an error, it was an answer: a `list()` that
 * returned 20 of 292 rows looked exactly like a complete read of 20, so
 * callers reasoned about a truncated set and hand-rolled a cursor loop once
 * they found out. Iterating the value gives the page it always gave;
 * `for await` gives the collection.
 */
import { collectModelList, modelList, type ModelList } from '../httpResources.js';

interface Row {
  id: string;
}

/** A paged collection served from a fixed set of rows, `size` at a time. */
function servePages(rows: readonly Row[], size: number): ModelList<Row> {
  const pageAt = (start: number): ModelList<Row> => {
    const slice = rows.slice(start, start + size);
    const end = start + size;
    return modelList<Row>(
      slice,
      { hasMore: end < rows.length, nextCursor: end < rows.length ? String(end) : null },
      (cursor) => Promise.resolve(pageAt(Number(cursor))),
    );
  };
  return pageAt(0);
}

const rowsOf = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `r_${i}` }));

describe('a list read', () => {
  it('is still the page it always was when iterated normally', () => {
    const list = servePages(rowsOf(50), 20);
    expect([...list]).toHaveLength(20);
    expect(list.hasMore).toBe(true);
  });

  it('yields every row when walked with `for await`', async () => {
    const seen: string[] = [];
    for await (const row of servePages(rowsOf(50), 20)) seen.push(row.id);
    expect(seen).toEqual(rowsOf(50).map((r) => r.id));
  });

  it('collects every row through the named complete-list path', async () => {
    await expect(collectModelList(servePages(rowsOf(50), 20))).resolves.toEqual(rowsOf(50));
  });

  it('bounds complete traversal by page count', async () => {
    await expect(
      collectModelList(servePages(rowsOf(50), 20), { maxPages: 2 }),
    ).rejects.toMatchObject({ code: 'invalid_options' });
  });

  it('honors an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectModelList(servePages(rowsOf(50), 20), { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
  });

  it('walks a collection that ends exactly on a page boundary', async () => {
    const seen: string[] = [];
    for await (const row of servePages(rowsOf(40), 20)) seen.push(row.id);
    expect(seen).toHaveLength(40);
  });

  it('is a single page when nothing follows', async () => {
    const seen: string[] = [];
    for await (const row of servePages(rowsOf(3), 20)) seen.push(row.id);
    expect(seen).toHaveLength(3);
  });

  it('fails loudly rather than returning an incomplete collection when the cursor stalls', async () => {
    const stuck = modelList<Row>(
      [{ id: 'r_0' }],
      { hasMore: true, nextCursor: 'same' },
      () =>
        Promise.resolve(
          modelList<Row>([{ id: 'r_1' }], { hasMore: true, nextCursor: 'same' }),
        ),
    );
    await expect(collectModelList(stuck)).rejects.toMatchObject({
      code: 'malformed_response',
      param: 'nextCursor',
    });
  });

  it('stays a plain array to everything that does not read the page state', () => {
    const list = servePages(rowsOf(50), 20);
    expect(JSON.parse(JSON.stringify(list))).toHaveLength(20);
    expect(Object.keys(list)).toEqual(rowsOf(20).map((_, i) => String(i)));
  });
});
