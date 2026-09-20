# Inkloom

**Specialised AI models for logo design.** Most tools generate an image and call
it a logo. Inkloom is building models that construct a mark the way a designer
does — a brand-analysis model turns a description of a business into
constraints, typography and symbol models work against those constraints, and a
composition engine produces lockups with real clear-space rules.

**[inkloom.art](https://inkloom.art)** · early access is open

---

## Status

Accounts, early access, promotional credits and the operations console are
live in production. **Generation is not built yet**, and nothing in the product
or on the site claims otherwise — `generation_enabled` and `payments_enabled`
are feature flags that default to false and are not switchable from the admin
UI, because enabling a flag whose feature does not exist exposes a broken
surface rather than a feature.

This repository is the platform those models will ship on: authentication, the
credit ledger, the access-code system, the admin console, and the operational
machinery around them — backups that are restore-tested, an alerting pair that
watches itself, and a deployment path that refuses to migrate a database nobody
has confirmed the identity of.

---

## Get it running

```bash
git clone <repo> && cd inkloom
cp .env.example .env          # safe local defaults; no real secrets
docker compose up -d --wait   # PostgreSQL + Mailpit, both on loopback only
pnpm install
pnpm db:migrate
pnpm db:seed                  # roles, flags, sample users, INKLOOMEARLYACCESS
pnpm dev                      # http://localhost:5173
```

Then:

| What            | Where                                                          |
| --------------- | -------------------------------------------------------------- |
| The app         | <http://localhost:5173>                                        |
| Email (Mailpit) | <http://localhost:8025> — a FAKE inbox; mail goes nowhere else |
| API description | <http://localhost:5173/api/v1/openapi.json>                    |
| Readiness probe | <http://localhost:5173/api/ready>                              |

### Become an admin

```bash
# 1. Sign up at /auth/signup, then confirm the address from Mailpit.
# 2. Promote that account — the ONLY way a super admin comes into existence:
pnpm bootstrap:superadmin --email you@example.com
# 3. Enrol two-factor at /app/security. Until you do, every admin request is
#    refused — that check is in middleware, so there is nothing to work around.
# 4. Open /admin
```

### Try the credit system

Redeem `INKLOOMEARLYACCESS` at `/app/redeem` for credits. Try it twice: the
second attempt is refused rather than doubling your balance, and the refusal is
enforced by a database constraint, not by a check you could race.

---

## Commands

```bash
pnpm dev                  # dev server (workerd, same runtime as production)
pnpm build                # production build
pnpm test                 # unit + integration + concurrency
pnpm test:unit            # pure functions, no database — fast
pnpm test:integration     # real Postgres, real transactions
pnpm test:security        # the security suite
pnpm test:e2e             # Playwright, real browser
pnpm lint                 # ESLint
pnpm format               # Prettier
pnpm typecheck            # tsc across every package

pnpm db:migrate           # apply migrations
pnpm db:generate          # generate a migration from schema changes
pnpm db:seed              # reference + development data
pnpm db:reset             # DESTRUCTIVE; asks you to type the database name
pnpm db:studio            # Drizzle Studio

pnpm bootstrap:superadmin --email you@example.com
pnpm codes:create --name "Launch" --credits 20
pnpm credits:reconcile    # ledger vs. wallet; exit 1 on drift
pnpm secrets:check        # scan source AND the built client bundle
pnpm email:test --to you@example.com   # prove mail actually delivers
pnpm mail:relay           # deliver to REAL inboxes locally, via your own mailbox
pnpm openapi:emit         # regenerate openapi.json
```

---

## What the platform does today

A visitor can understand the product, view reference marks, create an account,
verify their email, sign in, recover a password, redeem an early-access code,
receive promotional credits, see their balance and history, manage their profile
and sessions, contact support, and export or delete their account.

An operator can manage users, create and control access-code campaigns, grant or
remove credits with a reason, suspend accounts, revoke sessions, read the audit
and security trails, watch platform health, control feature flags, and use
emergency controls during an incident.

### What it deliberately does not do

Logo generation, model orchestration, uploads, checkout, subscriptions, credit
purchase, SVG editing, brand kits, a public API, team workspaces, SSO, or a
mobile app.

Every page says so in plain language. Nothing on the marketing site claims
Inkloom can generate a logo today, and the credits reserved during early access
are described as reserved rather than spendable.

---

## Documentation

| Document                                | What is in it                                      |
| --------------------------------------- | -------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System shape, every significant decision and why   |
| [DATABASE.md](docs/DATABASE.md)         | Entity diagram, all 27 tables, migrations, indexes |
| [API.md](docs/API.md)                   | Every endpoint, the envelope, error codes          |
| [AUTH.md](docs/AUTH.md)                 | Sessions, cookies, 2FA, the exact policy           |
| [CREDITS.md](docs/CREDITS.md)           | The ledger, access codes, concurrency guarantees   |
| [SECURITY.md](docs/SECURITY.md)         | Controls checklist, threat notes, secret rotation  |
| [ENVIRONMENT.md](docs/ENVIRONMENT.md)   | Every variable, where it lives, how to rotate it   |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)     | Staging, production, rollback                      |
| [OPERATIONS.md](docs/OPERATIONS.md)     | Backups, restore, incident response, alerting      |
| [TESTING.md](docs/TESTING.md)           | The test inventory and what each suite proves      |
| [V2.md](docs/V2.md)                     | How generation and payments slot in                |
| [LIMITATIONS.md](docs/LIMITATIONS.md)   | What is not done, honestly                         |

---

## The shape of it

```
inkloom/
├── apps/web/            React Router 8 (SSR) + the Cloudflare Worker entry
│   ├── app/             routes, components, client libraries
│   ├── workers/app.ts   ONE Worker: /api/* → Hono, /* → React SSR
│   └── wrangler.jsonc   bindings and per-environment vars (no secrets)
├── packages/
│   ├── db/              Drizzle schema, migrations, client
│   ├── core/            domain logic: credits, codes, RBAC, auth, limits
│   ├── api/             Hono routes, Zod schemas, OpenAPI
│   └── email/           templates and transports
├── e2e/                 Playwright
├── scripts/             seed, bootstrap, reconcile, secret scan
└── docs/
```

One Worker serves the application and the API on one origin. That is what makes
the session cookie first-party, removes CORS entirely, and lets the `__Host-`
cookie prefix apply.

---

## Tests

```
pnpm test            # 498 tests — unit, integration, concurrency, security
pnpm test:e2e        # Playwright, a real browser against a real Worker
```

| Suite                     | Tests   |
| ------------------------- | ------- |
| Unit                      | 336     |
| Integration + concurrency | 162     |
| Security                  | 68      |
| **Total**                 | **498** |

Run against a real PostgreSQL, a real browser and a real mail server — never a
mock of any of them, because the guarantees that matter here are transaction
guarantees and a mock cannot have them.

The most important single test is `redemption.concurrency.test.ts`, which fires
twenty-five simultaneous redemptions of one code by one user at a real database
and asserts that exactly one redemption row, one ledger entry and one balance
exist afterwards. The append-only tests matter for the same reason: they prove
the credit ledger and the audit log _refuse_ an UPDATE rather than merely
being written to carefully.

The end-to-end suite runs on demand rather than on every push. It passes in full
locally and cannot pass on a Linux CI runner, for an environment reason
unrelated to the application: miniflare places a Worker behind a network policy
that permits `public` and `private` addresses and not `local`, so the runtime
refuses the Worker's connection to a loopback database with an error identical
to a database that is not running.

---

## Security

Found a vulnerability? Please read [SECURITY.md](SECURITY.md) — it explains
where to send it and what to expect. Do not open a public issue.

The implemented controls, with the file that enforces each one, are listed in
[docs/SECURITY.md](docs/SECURITY.md). What is _not_ done is in
[docs/LIMITATIONS.md](docs/LIMITATIONS.md), stated plainly rather than omitted.

---

## Licence

Copyright © Inkloom. All rights reserved.

This source is published so the engineering can be read and audited. It is not
licensed for reuse, redistribution or derivative works. See [LICENCE](LICENCE).
