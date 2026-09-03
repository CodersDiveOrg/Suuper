export type TenantId = string;
export type UserId = string;

export type TenantRole = "owner" | "admin" | "member" | "viewer";

/** Carried on every authenticated request; injected by the API gateway from the validated JWT. */
export interface TenantContext {
  tenantId: TenantId;
  userId: UserId;
  roles: TenantRole[];
}

export interface Tenant {
  id: TenantId;
  name: string;
  slug: string;
  isolationTier: "shared" | "dedicated";
  createdAt: string;
}
