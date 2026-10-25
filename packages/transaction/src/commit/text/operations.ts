import { type } from 'ot-text-unicode';
import { AbloValidationError } from '../../errors.js';
import { textOperationSchema, textValueSchema, type TextOperation } from './contract.js';

/** Validate against the actual base: the OT library alone tolerates overlong deletes. */
function invertibleOperation(value: string, input: TextOperation): TextOperation {
  const characters = Array.from(textValueSchema.parse(value));
  const operation = textOperationSchema.parse(input);
  let position = 0;
  return operation.map((component) => {
    if (typeof component === 'string') return component;
    const count = typeof component === 'number'
      ? component
      : typeof component.d === 'number' ? component.d : Array.from(component.d).length;
    if (count > characters.length - position) {
      throw new AbloValidationError('Text operation exceeds its base value.', { code: 'invalid_input' });
    }
    const deleted = characters.slice(position, position + count).join('');
    position += count;
    if (typeof component === 'number') return component;
    if (typeof component.d === 'string' && component.d !== deleted) {
      throw new AbloValidationError('Deleted text does not match its base value.', { code: 'invalid_input' });
    }
    return { d: deleted };
  });
}

export function applyTextOperation(value: string, operation: TextOperation): string {
  return textValueSchema.parse(type.apply(value, type.normalize(invertibleOperation(value, operation))));
}

export function invertTextOperation(value: string, operation: TextOperation): TextOperation {
  if (!type.invert) throw new Error('The text OT implementation must support inversion.');
  return type.invert(type.normalize(invertibleOperation(value, operation)));
}

/** Keep individual operations: composing before transformation changes merge semantics. */
export function transformTextOperation(
  operation: TextOperation,
  concurrent: TextOperation,
  side: 'left' | 'right',
): TextOperation {
  return type.transform(
    type.normalize(textOperationSchema.parse(operation)),
    type.normalize(textOperationSchema.parse(concurrent)),
    side,
  );
}
