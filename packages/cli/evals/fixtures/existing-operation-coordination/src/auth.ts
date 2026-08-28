export function assertCanComplete(actorId: string, ownerId: string): void {
  if (actorId !== ownerId) throw new Error('forbidden');
}
