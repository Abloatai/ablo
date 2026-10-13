/** Server-owned claim namespace; never an application model or table. */
export const RESOURCE_CLAIM_MODEL = '$ablo_resource';

export async function resourceClaimId(workspaceId: string, resource: string): Promise<string> {
  if (!workspaceId || workspaceId.length > 1024 || !/^(file|ref):[^\0]+$/.test(resource) || resource.length > 4096) {
    throw new Error('Invalid workspace resource identity');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([workspaceId, resource])));
  return `resource:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
