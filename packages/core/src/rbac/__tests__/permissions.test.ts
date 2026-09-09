import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLES,
  hasPermission,
  highestRole,
  isAdminRole,
  PERMISSIONS,
  requiresReason,
  requiresReauth,
  ROLE_PERMISSIONS,
  ROLES,
  toRole,
  type Permission,
  type Role,
} from "../permissions";

describe("permission matrix integrity", () => {
  it("grants every role only permissions that actually exist", () => {
    const known = new Set(Object.keys(PERMISSIONS));
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(known, `${role} references unknown permission ${permission}`).toContain(permission);
      }
    }
  });

  it("gives super_admin every permission", () => {
    for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
      expect(hasPermission("super_admin", permission)).toBe(true);
    }
  });

  it("gives an ordinary user no permissions at all", () => {
    expect(ROLE_PERMISSIONS.user).toHaveLength(0);
    for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
      expect(hasPermission("user", permission)).toBe(false);
    }
  });

  it("never lets a user reach the admin area", () => {
    expect(hasPermission("user", "admin.access")).toBe(false);
    expect(isAdminRole("user")).toBe(false);
    expect(ADMIN_ROLES).not.toContain("user");
  });

  it("assigns no permission to a lower role that a higher role lacks", () => {
    // Guards against a paste error handing `support` something `admin` misses.
    const ladder: Role[] = ["support", "operations", "admin", "super_admin"];
    for (let i = 0; i < ladder.length - 1; i++) {
      const lower = ROLE_PERMISSIONS[ladder[i]!];
      const higher = ROLE_PERMISSIONS[ladder[i + 1]!];
      for (const permission of lower) {
        expect(higher, `${ladder[i + 1]} is missing ${permission} held by ${ladder[i]}`).toContain(
          permission,
        );
      }
    }
  });
});

describe("V1 privilege reservation", () => {
  // The brief: initially ONLY super_admin may create admins, modify roles,
  // create campaigns, adjust credits, change settings, or use emergency controls.
  const reserved: Permission[] = [
    "roles.assign",
    "codes.create",
    "credits.adjust",
    "credits.reverse",
    "settings.write",
    "system.emergency",
  ];

  it.each(reserved)("reserves %s to super_admin alone", (permission) => {
    for (const role of ROLES) {
      expect(hasPermission(role, permission)).toBe(role === "super_admin");
    }
  });
});

describe("containment vs. money", () => {
  it("lets operations contain an incident without minting credits", () => {
    expect(hasPermission("operations", "users.suspend")).toBe(true);
    expect(hasPermission("operations", "users.revoke_sessions")).toBe(true);
    expect(hasPermission("operations", "codes.pause")).toBe(true);
    expect(hasPermission("operations", "credits.adjust")).toBe(false);
    expect(hasPermission("operations", "codes.create")).toBe(false);
  });

  it("keeps support read-only over money and access", () => {
    expect(hasPermission("support", "credits.read")).toBe(true);
    expect(hasPermission("support", "credits.adjust")).toBe(false);
    expect(hasPermission("support", "users.suspend")).toBe(false);
    expect(hasPermission("support", "codes.create")).toBe(false);
  });
});

describe("sensitive-action gates", () => {
  it("requires re-authentication for every money- or privilege-moving action", () => {
    for (const permission of [
      "credits.adjust",
      "credits.reverse",
      "roles.assign",
      "codes.create",
      "codes.revoke",
      "settings.write",
      "system.emergency",
    ] as Permission[]) {
      expect(requiresReauth(permission), permission).toBe(true);
    }
  });

  it("does not demand re-authentication merely to read", () => {
    for (const permission of ["users.read", "audit.read", "credits.read"] as Permission[]) {
      expect(requiresReauth(permission)).toBe(false);
    }
  });

  it("requires a written reason for every high-impact action", () => {
    for (const permission of [
      "users.suspend",
      "credits.adjust",
      "roles.assign",
      "codes.revoke",
      "system.emergency",
    ] as Permission[]) {
      expect(requiresReason(permission), permission).toBe(true);
    }
  });
});

describe("role resolution", () => {
  it("falls back to 'user' for unknown, null or hostile values", () => {
    // A tampered database value or an injected role string must degrade to the
    // least privilege, never to more.
    for (const value of [null, undefined, "", "root", "administrator", 42, {}, ["admin"]]) {
      expect(toRole(value)).toBe("user");
    }
  });

  it("picks the highest rank when several grants exist", () => {
    expect(highestRole(["user", "support", "admin"])).toBe("admin");
    expect(highestRole(["support", "super_admin", "operations"])).toBe("super_admin");
    expect(highestRole([])).toBe("user");
    expect(highestRole(["user"])).toBe("user");
  });
});
