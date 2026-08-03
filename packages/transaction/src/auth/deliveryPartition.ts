import { z } from 'zod';

/**
 * Opaque gateway-routing coordinate resolved by the server.
 *
 * Clients echo this on the WebSocket upgrade; gateways still authenticate the
 * credential and recompute ownership, so it is routing metadata rather than an
 * authorization claim.
 */
export const deliveryPartitionRouteSchema = z.object({
  index: z.number().int().nonnegative(),
  count: z.number().int().min(2),
}).refine((route) => route.index < route.count, {
  message: 'delivery partition index must be less than count',
  path: ['index'],
});

export type DeliveryPartitionRoute = z.infer<typeof deliveryPartitionRouteSchema>;
