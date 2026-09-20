<div align="center">

# Inkloom

**Specialised AI models for logo design.**

[inkloom.art](https://inkloom.art)

</div>

---

## What we are building

A logo is not a picture. It is a constructed object with rules: a mark that
holds at sixteen pixels and on the side of a building, letterforms spaced by
eye rather than by metric, clear space derived from the mark's own geometry,
and lockups that still read when one of them is all you have room for.

General image models do not work this way. They produce something
logo-shaped — a plausible arrangement of marks with no construction behind it,
no reasoning about the business, and nothing you can hand to a printer or a
sign maker.

Inkloom is building models that construct a mark the way a studio does, as a
sequence of decisions that can each be explained:

| Stage                   | What it produces                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brand analysis**      | Turns a description of a business — sector, audience, tone, competitors — into concrete constraints: stroke weight, width, geometry, counter shape, which symbol families fit          |
| **Typography**          | Selects and fits letterforms against those constraints, then does the work that makes a wordmark: optical spacing, kerning at display size, a custom ligature where the name needs one |
| **Symbol construction** | Composes geometric primitives under construction rules — shared radii, tangent junctions, consistent terminals — so the result is built rather than sampled                            |
| **Composition**         | Optical alignment rather than mathematical centring, clear-space ratios taken from the mark itself, and the lockup variants a brand actually needs                                     |

The output is meant to be a specification, not a bitmap: a mark you can describe,
defend and reproduce.

---

## Where we are

**Early access is open at [inkloom.art](https://inkloom.art).** Create an
account, redeem a code, and credits are reserved against your account.

**Generation is not live yet.** We would rather say that plainly than imply
otherwise: every page in the product says so, credits are described as reserved
rather than spendable, and the feature flags that would switch generation on
default to off and are not togglable from the console — because enabling a flag
whose feature does not exist exposes a broken surface rather than a feature.

What runs today is the platform the models will ship on. Accounts and
authentication, the credit ledger, the access-code system, the operations
console, and the machinery around them: backups that are restore-tested rather
than merely taken, an alerting pair where each half watches what the other
cannot see, and a deployment path that refuses to migrate a database whose
identity has not been confirmed.

### What comes next

Generation itself, then the things that only make sense once it exists: export
in the formats a designer and a printer each need, brand kits, revision history
on a mark, and paid plans. None of it is claimed as present until it is.

---

## About this repository

This source is published so the engineering can be read and audited — in
particular the security and data-handling claims we make. It is not a
distribution: see [LICENCE](LICENCE).

|                                            |                                                           |
| ------------------------------------------ | --------------------------------------------------------- |
| [SECURITY.md](SECURITY.md)                 | Reporting a vulnerability, and what to expect             |
| [docs/SECURITY.md](docs/SECURITY.md)       | The controls that are implemented, and what enforces each |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | What is deliberately not done                             |

Built on Cloudflare Workers, Postgres and React Router, with the application and
its API served from one origin — which is what makes the session cookie
first-party and removes cross-origin handling entirely.

The test suite runs against a real database, a real browser and a real mail
server rather than mocks of any of them, because the guarantees that matter here
are transaction guarantees and a mock cannot have one. The test that matters
most fires twenty-five simultaneous redemptions of a single code at a real
database and asserts that exactly one redemption, one ledger entry and one
balance exist afterwards.

---

## Contact

|          |                                                                       |
| -------- | --------------------------------------------------------------------- |
| General  | <support@inkloom.art>                                                 |
| Security | <security@inkloom.art> — please read [SECURITY.md](SECURITY.md) first |

---

<div align="center">

Copyright © Inkloom. All rights reserved.

</div>
