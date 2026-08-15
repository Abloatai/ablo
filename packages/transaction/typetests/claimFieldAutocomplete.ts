/**
 * The proof that claim targets read the model's schema — and are definite
 * about it.
 *
 * `ClaimTargetOptions<T>` types `field`/`fields` with `ClaimField<T>`: the
 * model's own field names typecheck plainly. A typo'd field name and a
 * schema-external part are compile errors on this schema-bound surface, which
 * is the half a runtime test cannot express — hence the
 * `@ts-expect-error` below, which fails this program if the strictness is
 * ever loosened back to `string`.
 */

import type {
  ClaimField,
  ClaimParams,
} from '@abloatai/transaction/resources/modelOperations';
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

interface Item {
  id: string;
  title: string;
  status: string;
}

// ── The model's fields survive as literals (autocomplete's raw material) ──

export const fieldLiteralsSurvive: Identical<
  ClaimField<Item>['field'],
  'title' | 'status'
> = true;

// Over bare `string` the same Extract collapses to `never` — that difference
// is the assertion.
export const bareStringWouldNot: Identical<Extract<string, 'title'>, never> =
  true;

export const schemaField: ClaimParams<Item> = {
  id: 't_1',
  fields: (item) => item.title,
};

export const typo: ClaimParams<Item> = {
  id: 't_1',
  // @ts-expect-error — typo: the field is not declared by Item's Zod shape.
  fields: (item) => [item.titel],
};

export const stringField: ClaimParams<Item> = {
  id: 't_1',
  // @ts-expect-error — model claims cannot accept unstructured field strings.
  fields: ['title'],
};

export const frameworkField: ClaimParams<Item> = {
  id: 't_1',
  // @ts-expect-error — framework identity is not a Zod-declared claim field.
  fields: (item) => item.id,
};
