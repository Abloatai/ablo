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
} from '@ablo/transaction/resources/modelOperations';
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

interface Task {
  id: string;
  title: string;
  status: string;
}

// ── The model's fields survive as literals (autocomplete's raw material) ──

export const fieldLiteralsSurvive: Identical<
  ClaimField<Task>['field'],
  'title' | 'status'
> = true;

// Over bare `string` the same Extract collapses to `never` — that difference
// is the assertion.
export const bareStringWouldNot: Identical<Extract<string, 'title'>, never> =
  true;

export const schemaField: ClaimParams<Task> = {
  id: 't_1',
  fields: (task) => task.title,
};

export const typo: ClaimParams<Task> = {
  id: 't_1',
  // @ts-expect-error — typo: the field is not declared by Task's Zod shape.
  fields: (task) => [task.titel],
};

export const stringField: ClaimParams<Task> = {
  id: 't_1',
  // @ts-expect-error — model claims cannot accept unstructured field strings.
  fields: ['title'],
};

export const frameworkField: ClaimParams<Task> = {
  id: 't_1',
  // @ts-expect-error — framework identity is not a Zod-declared claim field.
  fields: (task) => task.id,
};
