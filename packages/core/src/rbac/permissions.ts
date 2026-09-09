/**
 * The permission matrix.
 *
 * Authorization is decided HERE, on the server, from the role stored in the
 * database — never from anything the client sends. Hiding a button is a UX
 * nicety; `requirePermission` is the control.
 *
 * Adding a permission means adding it to `PERMISSIONS` and to at least one
 * role, both of which are compile-time checked, so a new admin endpoint cannot
 * accidentally ship ungated.
 */

export const PERMISSIONS = {
  // --- overview ---
  "admin.access": "Open the admin area at all",
  "admin.overview.read": "View the admin dashboard metrics",

  // --- users ---
  "users.read": "Search and view user accounts",
  "users.suspend": "Suspend and unsuspend accounts",
  "users.revoke_sessions": "Revoke another user's sessions",
  "users.resend_verification": "Trigger a verification email for a user",
  "users.note": "Write internal notes on an account",
  "users.export": "Export permitted account information",

  // --- roles ---
  "roles.read": "See who holds which role",
  "roles.assign": "Grant and revoke roles, including creating admins",

  // --- access codes ---
  "codes.read": "View campaigns and redemption reports",
  "codes.create": "Create a code campaign",
  "codes.update": "Edit campaign metadata and limits",
  "codes.pause": "Pause and resume a campaign",
  "codes.revoke": "Revoke a campaign permanently",

  // --- credits ---
  "credits.read": "View wallets and ledger history",
  "credits.adjust": "Grant or deduct credits manually",
  "credits.reverse": "Reverse a previous adjustment",
  "credits.reconcile": "Run wallet/ledger reconciliation",

  // --- observability ---
  "audit.read": "Read the audit trail",
  "security.read": "Read security events and abuse flags",

  // --- support ---
  "support.read": "Read the support queue",
  "support.respond": "Update status and respond to support requests",

  // --- system ---
  "settings.read": "View system settings and feature flags",
  "settings.write": "Change system settings and feature flags",
  "system.emergency": "Use emergency controls (mass logout, pause signups)",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ROLES = ["user", "support", "operations", "admin", "super_admin"] as const;
export type Role = (typeof ROLES)[number];

/** Higher wins when a user somehow holds several roles. */
export const ROLE_RANK: Record<Role, number> = {
  user: 0,
  support: 10,
  operations: 20,
  admin: 30,
  super_admin: 40,
};

/**
 * Role -> permissions.
 *
 * Deliberately explicit rather than inherited: reading this table tells you
 * exactly what a role can do, with no need to trace a hierarchy. The brief
 * requires that INITIALLY only `super_admin` can create admins, change roles,
 * create campaigns, adjust credits, change settings, or use emergency
 * controls — that constraint is encoded literally below.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  user: [],

  // Front-line support: can see accounts and answer tickets, can change nothing
  // that moves money or grants access.
  support: [
    "admin.access",
    "users.read",
    "users.note",
    "users.resend_verification",
    "support.read",
    "support.respond",
    "codes.read",
    "credits.read",
  ],

  // Operations: everything support can do, plus containment actions and
  // visibility into security. Still cannot mint credits or codes.
  operations: [
    "admin.access",
    "admin.overview.read",
    "users.read",
    "users.note",
    "users.resend_verification",
    "users.suspend",
    "users.revoke_sessions",
    "users.export",
    "support.read",
    "support.respond",
    "codes.read",
    "codes.pause",
    "credits.read",
    "audit.read",
    "security.read",
    "settings.read",
    "roles.read",
  ],

  // Admin: full read plus campaign lifecycle. Note the omissions — no
  // `credits.adjust`, no `roles.assign`, no `settings.write`, no
  // `system.emergency`. Those stay with super_admin in V1.
  admin: [
    "admin.access",
    "admin.overview.read",
    "users.read",
    "users.note",
    "users.resend_verification",
    "users.suspend",
    "users.revoke_sessions",
    "users.export",
    "support.read",
    "support.respond",
    "codes.read",
    "codes.update",
    "codes.pause",
    "codes.revoke",
    "credits.read",
    "credits.reconcile",
    "audit.read",
    "security.read",
    "settings.read",
    "roles.read",
  ],

  super_admin: Object.keys(PERMISSIONS) as Permission[],
};

/** Roles that may enter the admin area at all. Used by the admin plugin config. */
export const ADMIN_ROLES: readonly Role[] = ["support", "operations", "admin", "super_admin"];

/**
 * Actions that demand a fresh password/2FA confirmation before proceeding,
 * regardless of who is asking. A stolen but idle admin session cannot mint
 * credits or fire an emergency control.
 */
export const REAUTH_REQUIRED_PERMISSIONS: readonly Permission[] = [
  "roles.assign",
  "credits.adjust",
  "credits.reverse",
  "codes.create",
  "codes.revoke",
  "settings.write",
  "system.emergency",
];

/** Actions that must carry a written reason, recorded in the audit trail. */
export const REASON_REQUIRED_PERMISSIONS: readonly Permission[] = [
  "users.suspend",
  "roles.assign",
  "credits.adjust",
  "credits.reverse",
  "codes.revoke",
  "settings.write",
  "system.emergency",
];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Normalise an unknown role value from the database into a safe Role. */
export function toRole(value: unknown): Role {
  return isRole(value) ? value : "user";
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Effective role when a user holds several grants: the highest rank wins. */
export function highestRole(roles: readonly Role[]): Role {
  return roles.reduce<Role>((best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best), "user");
}

export function isAdminRole(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

export function requiresReauth(permission: Permission): boolean {
  return REAUTH_REQUIRED_PERMISSIONS.includes(permission);
}

export function requiresReason(permission: Permission): boolean {
  return REASON_REQUIRED_PERMISSIONS.includes(permission);
}
