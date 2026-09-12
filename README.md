# Inkloom — V1

Inkloom is building specialised AI models for logo design. **V1 is the secure
production foundation, not the product**: accounts, early access, promotional
credits and an admin console. Logo generation and payments are deliberately not
built, and are held behind feature flags that default to off.

Everything in this repository runs. The claims below are backed by tests you can
execute on your own machine in about five minutes.

---

## Get it running

```bash
git clone <repo> && cd inkloom
cp .env.example .env          # safe local defaults; no real secrets
docker compose up -d --wait   # PostgreSQL + Mailpit, both on loopback only
pnpm install
pnpm db:migrate
pnpm db:seed                  # roles, flags, sample users, INKLOOMHACKATHON
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

Redeem `INKLOOMHACKATHON` at `/app/redeem` for $20 in credits. Try it twice: the
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

## What V1 does

A visitor can understand the product, view reference marks, create an account,
verify their email, sign in, recover a password, redeem an early-access code,
receive promotional credits, see their balance and history, manage their profile
and sessions, contact support, and export or delete their account.

An operator can manage users, create and control access-code campaigns, grant or
remove credits with a reason, suspend accounts, revoke sessions, read the audit
and security trails, watch platform health, control feature flags, and use
emergency controls during an incident.

### What V1 deliberately does not do

Logo generation, model orchestration, uploads, checkout, subscriptions, credit
purchase, SVG editing, brand kits, a public API, team workspaces, SSO, or a
mobile app. The `generation_enabled` and `payments_enabled` flags exist, default
to false, and are not switchable from the admin UI — enabling a flag whose
feature does not exist would expose a broken surface, not a feature.

Every page says so in plain language. Nothing on the marketing site claims
Inkloom can generate a logo today.

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

## Test results

Run on 10 September 2026, against a real PostgreSQL, a real browser and a real
mail server. Reproduce with the commands above.

| Suite                     | Tests   | Result   |
| ------------------------- | ------- | -------- |
| Unit                      | 82      | pass     |
| Integration + concurrency | 45      | pass     |
| Security                  | 54      | pass     |
| End-to-end (Playwright)   | 96      | pass     |
| **Total**                 | **277** | **pass** |

The end-to-end figure counts **both** Playwright projects — 74 in `chromium` plus
22 in `mobile`, which re-runs the accessibility and phone-layout journeys on a
Pixel 7. An earlier revision of this table said 65, having counted `chromium`
alone; the mobile project was running but going untallied.

Also clean: `tsc` across every package, ESLint, Prettier, and the secret scan
against a real production client bundle.

The most important of these is `redemption.concurrency.test.ts`, which fires 25
simultaneous redemptions of one code by one user against a real database and
asserts that exactly one redemption row, one ledger entry and 500 credits exist
afterwards.

---

## Licence

Proprietary. All rights reserved.
