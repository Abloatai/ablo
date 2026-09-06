import { randomUUID, timingSafeEqual } from 'node:crypto';
import { syncGroup } from '@abloatai/ablo/schema';

// Local reference identities. Replace password verification and this membership
// lookup with your application auth; never accept groups supplied by a browser.
const members = { alice: ['alpha', 'beta'], bob: ['alpha'], eve: ['beta'] };
export type User = keyof typeof members;
const logins = new Map<string, User>();
export function signIn(user: string, password: string): string | null {
  const expected = process.env.DEMO_PASSWORD;
  if (!expected || !Object.hasOwn(members, user)) return null;
  const a = Buffer.from(password), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const token = randomUUID();
  logins.set(token, user as User);
  return token;
}
export function authenticate(request: Request): User | null {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)demo=([^;]+)/)?.[1];
  return token ? logins.get(token) ?? null : null;
}
export function authorizeAccount(user: User, account: string): boolean {
  return members[user].includes(account);
}
export function grantAccount(user: User, account: string) {
  if (!authorizeAccount(user, account)) return null;
  return {
    user: { id: user },
    groups: [syncGroup('account', account)],
    can: { conversations: ['read'] as const },
  };
}
export function grantWriter(user: User, account: string) {
  const grant = grantAccount(user, account);
  return grant && { ...grant, can: { conversations: ['read', 'create', 'update'] as const } };
}
export function grantAgent(account: string, agentId: string) {
  return {
    agent: { id: agentId },
    groups: [syncGroup('account', account)],
    can: { conversations: ['read', 'update'] as const },
  };
}
