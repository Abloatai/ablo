import { z } from 'zod';

/** Canonical bearer-token field used by every successful auth response. */
export const authTokenSchema = z.string().trim().min(1);
