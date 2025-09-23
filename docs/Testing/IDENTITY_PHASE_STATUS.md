# Identity Phase Status Report

_Last updated: September 23, 2025_

## Completed Work
- **Phase 0 harness stabilization**: `apps/api/src/__tests__/setup/postgres-test-container.ts` now reuses the Docker Compose Postgres instance when available and falls back to an ephemeral cluster for CI, eliminating the earlier multi-minute boot time.
- **Dual-datasource factories**: `createSqliteDataSource()` and `createPostgresDataSource()` register sqlite-friendly fixture entities and the canonical Postgres entities respectively (`apps/api/src/__tests__/setup/datasource.factory.ts`).
- **Identity entities implemented**: Added `UserSettings`, `UserAuthIdentity`, and their sqlite mirrors with JSON defaults, check constraints, and cascade bindings (`apps/api/src/entities/user-settings.entity.ts`, `user-auth-identity.entity.ts`, and counterparts).
- **Test coverage**: Both sqlite and Postgres suites validate defaults, unique constraints, citext behaviour, and jsonb persistence (`apps/api/src/__tests__/identity/user*.spec.ts`). Jest now runs single-threaded to prevent concurrent schema rebuilds (`apps/api/package.json`).
- **User device tracking**: Added `UserDevice` entities for Postgres + sql.js along with parity specs to ensure default sync metadata and uniqueness enforcement (`apps/api/src/entities/user-device.entity.ts`, `apps/api/src/__tests__/identity/user-device.postgres.spec.ts`).
- **Migration coverage**: Authored `001_enable_extensions` and `002_identity_tables` migrations and backed them with forward/rollback specs to guard drift (`apps/api/src/database/migrations/001_enable_extensions.ts`, `apps/api/src/__tests__/migrations/identity.migrations.spec.ts`).
- **Seed idempotency**: Implemented `seedDefaultUserSettings` with Postgres tests verifying a stable re-run (`apps/api/src/database/seeds/default-user-settings.seed.ts`, `apps/api/src/__tests__/seeds/default-user-settings.seed.spec.ts`).
- **Doc sync**: Refreshed `docs/DATABASE_SCHEMA.md` to capture citext emails, persistence modes, auth identities, and device metadata.
- **Checklist cross-link**: Added `docs/Testing/IDENTITY_PHASE_CHECKLIST.md` so Phase 1 tracking points back to this status report.
- **CI integration**: Main workflow now provisions Postgres and executes `pnpm --filter api test`, ensuring identity + migration suites run on PRs (`.github/workflows/main.yml`).

## Key Decisions & Rationale
- **SQLite mirrors**: Keep fast, deterministic sql.js tests around the same schema, reserving Postgres runs for citext/enum/jsonb specific behaviour.
- **Synchronized schema**: Using `dataSource.synchronize()` temporarily until migrations land, ensuring specs stay aligned as entities evolve.
- **Connection reuse**: Prioritized existing Docker Compose DB to avoid competing with nested `initdb` calls and to mirror developer environments.

## Pending Tasks
1. None — monitoring for downstream consumers once collaboration schema work begins.

## Blocking Issues
- None currently; the harness and identity suite run green locally via `pnpm --filter api test` in ~2.5s.

## Next Checkpoint
- Target completion of the remaining Phase 1 entities and migration specs before moving into collaboration tables (Phase 2) per `docs/planning/TDD_DATABASE_DESIGN_PLAN.md`.
