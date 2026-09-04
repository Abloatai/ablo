import { z } from 'zod';

/** HTTP attribution header. Authentication and authorization ignore it. */
export const PRESENCE_SESSION_HEADER = 'Ablo-Presence-Session';

/** Browser-safe WebSocket resume credential; the server never echoes it as the selected protocol. */
export const WS_PRESENCE_SESSION_SUBPROTOCOL_PREFIX = 'ablo.presence.';

export const presenceSessionIdSchema = z.uuid();

export const presenceSessionEstablishedSchema = z
  .object({
    presenceSessionId: presenceSessionIdSchema,
    resumed: z.boolean(),
  })
  .strict();
export type PresenceSessionEstablished = z.infer<typeof presenceSessionEstablishedSchema>;

/** One in-memory holder owned by an SDK instance and shared by all of its transports. */
export interface PresenceSessionSource {
  get(): string | null;
  establish(value: PresenceSessionEstablished): void;
  establishFromHeader(value: string | null): boolean;
  withHeader(headers?: Record<string, string>): Record<string, string>;
}

export function createPresenceSessionSource(): PresenceSessionSource {
  let presenceSessionId: string | null = null;

  return {
    get: () => presenceSessionId,
    establish(value) {
      presenceSessionId = presenceSessionEstablishedSchema.parse(value).presenceSessionId;
    },
    establishFromHeader(value) {
      const parsed = presenceSessionIdSchema.safeParse(value);
      if (!parsed.success) return false;
      presenceSessionId = parsed.data;
      return true;
    },
    withHeader(headers = {}) {
      return presenceSessionId === null
        ? { ...headers }
        : { ...headers, [PRESENCE_SESSION_HEADER]: presenceSessionId };
    },
  };
}
