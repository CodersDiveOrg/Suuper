export type BusinessId = string;
export type UserId = string;

/**
 * A business is an organisation on the platform. Users join businesses through
 * a Membership; the same user can be a member of several businesses at once and
 * hold a different role in each.
 */
export interface Business {
  id: BusinessId;
  name: string;
  slug: string;
  /**
   * Where this business's rows physically live. Starts "shared" for everyone;
   * a large business can be promoted to "dedicated" later without app changes.
   */
  isolationTier: "shared" | "dedicated";
  createdAt: string;
}

/** Roles every business has. They can't be edited or deleted. */
export type BuiltInRole = "owner" | "admin" | "member" | "viewer";

export const BUILT_IN_ROLES: BuiltInRole[] = ["owner", "admin", "member", "viewer"];

/** @deprecated use BUILT_IN_ROLES */
export const BUSINESS_ROLES = BUILT_IN_ROLES;

/**
 * A role key: either a built-in role or the key of a business's custom role
 * (see the Role model). Custom keys never collide with built-in ones.
 */
export type BusinessRole = BuiltInRole | (string & {});

export function isBuiltInRole(role: string): role is BuiltInRole {
  return (BUILT_IN_ROLES as string[]).includes(role);
}

export interface User {
  id: UserId;
  email: string;
  name?: string;
  createdAt: string;
}

/** A user's place in one business. */
export interface Membership {
  id: string;
  userId: UserId;
  businessId: BusinessId;
  role: BusinessRole;
  createdAt: string;
}

/** A business the current user belongs to, as returned by the login/me endpoints. */
export interface BusinessSummary {
  id: BusinessId;
  name: string;
  slug: string;
  role: BusinessRole;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Invitation {
  id: string;
  businessId: BusinessId;
  email: string;
  role: BusinessRole;
  status: InvitationStatus;
  invitedByUserId: UserId;
  expiresAt: string;
  createdAt: string;
}

/**
 * Attached to every request that acts inside a business. Built by the API
 * gateway / services from a validated business-scoped JWT — never from a
 * client-supplied business id.
 */
export interface BusinessContext {
  userId: UserId;
  businessId: BusinessId;
  role: BusinessRole;
  permissions: Permission[];
}

/** Attached to requests authenticated as a user but not yet scoped to a business. */
export interface UserContext {
  userId: UserId;
}

// --- Permissions -----------------------------------------------------------

export type Permission =
  | "business:read"
  | "business:manage"
  | "members:read"
  | "members:invite"
  | "members:manage"
  | "bots:read"
  | "bots:write"
  | "bots:run"
  | "agents:read"
  | "agents:write"
  | "agents:run"
  | "workflows:read"
  | "workflows:write"
  | "workflows:run"
  | "apps:read"
  | "apps:write"
  | "apps:records"
  | "mcp:read"
  | "mcp:write"
  | "knowledge:read"
  | "knowledge:write"
  | "roles:manage"
  | "integrations:read"
  | "integrations:write"
  | "webhooks:read"
  | "webhooks:write"
  | "audit:read";

export const ALL_PERMISSIONS: Permission[] = [
  "business:read",
  "business:manage",
  "members:read",
  "members:invite",
  "members:manage",
  "bots:read",
  "bots:write",
  "bots:run",
  "agents:read",
  "agents:write",
  "agents:run",
  "workflows:read",
  "workflows:write",
  "workflows:run",
  "apps:read",
  "apps:write",
  "apps:records",
  "mcp:read",
  "mcp:write",
  "knowledge:read",
  "knowledge:write",
  "roles:manage",
  "integrations:read",
  "integrations:write",
  "webhooks:read",
  "webhooks:write",
  "audit:read",
];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

/**
 * Built-in role -> permission mapping. Custom roles store their own permission
 * list in the Role table; identity-service resolves those (permissionsForRole
 * only knows built-ins and returns [] for anything else).
 */
const ROLE_PERMISSIONS: Record<BuiltInRole, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: [
    "business:read",
    "members:read",
    "members:invite",
    "members:manage",
    "bots:read",
    "bots:write",
    "bots:run",
    "agents:read",
    "agents:write",
    "agents:run",
    "workflows:read",
    "workflows:write",
    "workflows:run",
    "apps:read",
    "apps:write",
    "apps:records",
    "mcp:read",
    "mcp:write",
    "knowledge:read",
    "knowledge:write",
    "roles:manage",
    "integrations:read",
    "integrations:write",
    "webhooks:read",
    "webhooks:write",
    "audit:read",
  ],
  member: [
    "business:read",
    "members:read",
    "bots:read",
    "bots:run",
    "agents:read",
    "agents:run",
    "workflows:read",
    "workflows:run",
    "apps:read",
    "apps:records",
    "mcp:read",
    "knowledge:read",
    "integrations:read",
  ],
  viewer: [
    "business:read",
    "members:read",
    "bots:read",
    "agents:read",
    "workflows:read",
    "apps:read",
    "mcp:read",
    "knowledge:read",
    "integrations:read",
  ],
};

export function permissionsForRole(role: BusinessRole): Permission[] {
  return isBuiltInRole(role) ? ROLE_PERMISSIONS[role] : [];
}

export const BUILT_IN_ROLE_INFO: Record<BuiltInRole, { name: string; description: string }> = {
  owner: { name: "Owner", description: "Full access, including billing and deleting the business." },
  admin: { name: "Admin", description: "Manages members, roles, integrations and everything you build." },
  member: { name: "Member", description: "Uses bots and agents, and can read everything else." },
  viewer: { name: "Viewer", description: "Read-only access." },
};

/** A role as listed for a business: built-ins plus its custom roles. */
export interface RoleDto {
  key: BusinessRole;
  name: string;
  description?: string;
  permissions: Permission[];
  builtIn: boolean;
  memberCount: number;
  id?: string;
  createdAt?: string;
}

export function roleHasPermission(role: BusinessRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}
