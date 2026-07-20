## Context

Five call sites resolve JWT secrets as `process.env.X || '<published
literal>'`. The fallback executes silently, so a deployment without
configured secrets serves tokens verifiable by anyone with repository
access. The repository already has the shape this fix needs:
`database-target-policy.ts` is a pure, env-record-driven resolver with
fail-closed isolated tests and a registered check
(`api-database-policy-test`).

## Goals / Non-Goals

**Goals:**

- One resolver as the single authority for JWT secrets; no inline fallback
  survives anywhere.
- Missing or forbidden secrets fail API startup, not the first request.
- Tests keep passing by supplying explicit secrets — test convenience never
  re-enters production code.

**Non-Goals:**

- Secret rotation, revocation, token-lifetime changes, or a runtime
  test-mode flag.

## Decisions

### Pure resolver, forbidden literals, no bypass

`resolveJwtSecrets(env)` mirrors `resolvePostgresTestDatabaseUrl`: a pure
function over an env record, unit-testable without Nest. It rejects missing
and blank values, rejects the two published development literals even when
set deliberately (they are public knowledge in Git history), and rejects
equal access/refresh secrets. The "explicit local test mode" from ISS-111 is
satisfied by test setups exporting their own secrets — a resolver-level
bypass flag would just be the fallback with extra steps.

Alternative: validate once in a config schema and trust `ConfigService`.
Rejected — the guard and service read `process.env` directly today, and a
schema leaves per-call-site drift possible; one resolver call at each
consumer is auditable.

### Startup failure via `registerAsync`

`JwtModule.register` evaluates its options at decorator evaluation;
`registerAsync` with a factory resolves during application bootstrap, which
is the correct failure point: the API refuses to start instead of throwing
on first token use. Guard and service call the resolver at use time, so even
a process with mutated env fails closed per operation.

### Literal-absence regression test

The leak is the literal string, so the isolated suite reads the five source
files and asserts neither published literal appears. This pins the repair
against reintroduction by future edits, the same ethos as the engine's
byte-exact contract tests.

## Risks / Trade-offs

- **[Deployments relying on implicit dev secrets break]** → intended;
  breaking startup is the fix. The error message names the missing variable.
- **[Integration suites implicitly used the fallbacks]** → the shared test
  setup now exports explicit test secrets, keeping CI green while proving
  the explicit-configuration path.
- **[Resolver called per operation adds cost]** → string comparisons on an
  in-memory record; negligible against JWT crypto.
