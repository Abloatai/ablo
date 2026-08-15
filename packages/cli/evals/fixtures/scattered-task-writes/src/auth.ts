export function assertCanEdit(actorId: string, ownerId: string): void {
  if (actorId !== ownerId) throw new Error('forbidden');
}
