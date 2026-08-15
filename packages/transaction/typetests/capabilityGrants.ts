import type { CapabilityCan } from '../src/auth/capability.js';

type Models = {
  items: {};
  comments: {};
};

const valid: CapabilityCan<Models> = {
  items: ['read', 'update'],
};

// @ts-expect-error A capability must grant at least one model.
const empty: CapabilityCan<Models> = {};

// @ts-expect-error A named model must grant at least one operation.
const emptyOperations: CapabilityCan<Models> = { items: [] };

// @ts-expect-error Capability keys are the schema's model keys.
const unknownModel: CapabilityCan<Models> = { documents: ['read'] };

void valid;
void empty;
void emptyOperations;
void unknownModel;
