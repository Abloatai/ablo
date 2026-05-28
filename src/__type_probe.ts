/* eslint-disable */
import { z } from 'zod';
import { defineSchema } from "./schema/schema.js";
import { mutable } from './schema/sugar.js';

const probeSchema = defineSchema({
  invitations: mutable.lazy(
    { status: z.string(), email: z.string() },
    {
      typename: 'Invitation',
      computed: {
        isPending: (self: Record<string, unknown>): boolean => self.status === 'pending',
        isExpired: (self: Record<string, unknown>): boolean => false,
      },
    }
  ),
});

import type { InferModel } from './schema/schema.js';
export type Probe_Invitation = InferModel<typeof probeSchema, 'invitations'>;
declare const probe: Probe_Invitation;
export { probe };
