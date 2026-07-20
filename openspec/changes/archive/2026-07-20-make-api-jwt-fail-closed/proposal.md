## Why

Production-capable API code falls back to published development JWT secrets
(`development-secret-change-in-production`, `development-refresh-secret`) in
five places: token verification in the auth guard, module registration,
refresh verification, token signing, and app config. Anyone reading the
repository can mint valid access and refresh tokens for a deployment that
forgot to set `JWT_SECRET`/`JWT_REFRESH_SECRET`. This is ISS-111, the
security item in the roadmap's "Now" set.

## What Changes

- Add one fail-closed secret resolver: `resolveJwtSecrets(env)` requires
  `JWT_SECRET` and `JWT_REFRESH_SECRET` to be present, non-empty after
  trimming, distinct from each other, and different from the two published
  development literals — which stay forbidden even when set explicitly,
  because they are burned into Git history. On any violation it throws a
  startup error naming the variable; it never returns a default.
- Wire every consumer through the resolver: JWT module registration moves to
  `registerAsync` so a missing secret fails API bootstrap, and the guard's
  verification, the service's refresh verification and token signing, and
  the app config all stop carrying inline fallbacks. **BREAKING** for
  deployments that relied on the implicit development secrets — startup now
  fails until real secrets are configured.
- Give the API test setup explicit test secrets; the tests supplying their
  own values is the explicit local test mode, so no bypass flag exists in
  production code.
- Add a regression test asserting the forbidden literals no longer appear in
  the auth source files.

Non-goals: token revocation/logout, secret rotation, changing token
lifetimes, or any mobile-side auth work.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `identity-and-access`: API authentication secrets become fail-closed —
  startup and every token operation require explicitly configured secrets.

## Impact

- Affected source: `apps/api/src/config/jwt-secret-policy.ts` (new),
  `apps/api/src/modules/auth.module.ts`,
  `apps/api/src/services/auth.service.ts`,
  `apps/api/src/guards/jwt-auth.guard.ts`,
  `apps/api/src/config/app.config.ts`.
- Affected tests: `apps/api/src/__tests__/isolated/jwt-secret-policy.isolated.spec.ts`
  (new), `apps/api/src/__tests__/setup.ts` (explicit test secrets).
- Closes ISS-111. Deployment environments must define both secrets before
  upgrading.
