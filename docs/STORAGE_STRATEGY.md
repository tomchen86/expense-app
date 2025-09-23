# Storage Strategy

_Last updated: September 23, 2025_

## Purpose
Define how the expense platform persists data across local and cloud surfaces while letting each user choose the mode that fits their needs. This strategy keeps the mobile experience offline-friendly today, enables an API-backed sync path in Phase 2, and leaves room for richer analytics later.

## Guiding Principles
- **Offline-first UX**: The app must remain functional without connectivity and reconcile once back online.
- **Single runtime state**: Zustand stays the in-memory source of truth so UI logic does not depend on storage implementation details.
- **Pluggable persistence**: Storage providers implement a common contract and can be swapped per user preference or per feature.
- **Security & integrity**: Sensitive data is encrypted at rest where possible; schema evolution must protect historical records.
- **Operational simplicity**: Favor managed services and incremental upgrades so a solo developer can maintain the stack.

## Layered Architecture
1. **Domain state (Zustand)**
   - Holds normalized expense, group, category, and user settings slices.
   - Emits events when mutations occur so persistence providers can react.
   - Hydrates from a chosen provider during app bootstrap and pushes changes back through a single dispatcher.
2. **Persistence provider interface**
   - Methods: `hydrate()`, `persist(changeset)`, `subscribe(listener)`, `migrate(version)`, and `clear()`.
   - Supports optimistic updates, version stamps, and conflict hints.
3. **Provider implementations**
   - **AsyncStorage/MMKV (baseline)**: JSON snapshot suitable for prototypes and minimal data sets.
   - **SQLite (advanced local)**: Structured tables for history, analytics, and large datasets with deterministic migrations.
   - **Cloud Sync (API)**: REST/React Query client backed by PostgreSQL via NestJS. Uses per-record versioning and a queue for pending mutations.

## Supported Modes
### Local-only mode (default today)
- Provider: AsyncStorage (graduating to SQLite once implemented).
- Use case: Privacy-sensitive users who do not want cloud sync or are experimenting without accounts.
- Behaviour: All writes persist locally; sync queue remains disabled.

### Cloud-sync mode (Phase 2.3)
- Providers: SQLite as the on-device cache + cloud sync provider for round-trips.
- Use case: Couples/groups who expect multi-device consistency.
- Behaviour: Writes enqueue locally, dispatch to API, and reconcile responses. Reads combine cache + remote freshness checks via React Query.

### Mode switching
1. User selects mode from Settings.
2. Persistence manager locks writes, flushes in-flight operations.
3. Executes migration utility:
   - Local → Cloud: push local snapshot through sync API, capture returned canonical IDs.
   - Cloud → Local: download latest snapshot, invalidate auth tokens if offline-only.
4. Rehydrates Zustand state from the target provider and resumes normal operations.

## Local Storage Options
| Option | When to use | Pros | Cons |
| --- | --- | --- | --- |
| AsyncStorage/MMKV | Small datasets, MVP flows, encrypted key/value needs | Built-in, zero schema management, quick to ship | Brittle for large lists, no relational querying, harder diffing |
| SQLite (expo-sqlite-async, Drizzle RN, WatermelonDB) | Rich filtering, analytics, deterministic migrations | Relational queries, partial-sync tables, better performance on large sets | Additional native dependency, migration tooling to maintain |

Decision: ship AsyncStorage persistence in production now; target SQLite-backed provider before launching cloud sync so the mobile app can handle >10 k records offline without JSON bloat.

## Cloud Persistence Stack
- **Primary database**: PostgreSQL (ADR-003) hosted on managed service (Supabase initially, migratable to AWS RDS/Aurora).
- **API layer**: NestJS + TypeORM with optimistic concurrency columns (`updated_at`, `version`) and soft-delete markers.
- **Auth**: JWT with refresh rotation (ADR-005) to authenticate sync requests.
- **File assets**: S3-compatible object storage for receipt uploads, referenced by expenses.

## Sync & Conflict Handling
- Every record carries `updatedAt` and `syncVersion` integers.
- Mobile queue batches writes per entity type; server accepts if `syncVersion` matches, otherwise returns conflict payload.
- Client resolves conflicts via rules:
  1. Auto-merge numeric totals and notes when mutation windows do not overlap.
  2. Prompt user for manual resolution when both sides edited the same fields.
- Scheduled `syncPendingOperations()` runs on app foreground, network reconnect, and manual pull-to-refresh.

## Implementation Plan (Maps to Roadmap Phase 2)
| Milestone | Target Phase | Highlights |
| --- | --- | --- |
| Persistence interface + AsyncStorage adapter | Phase 2.2 groundwork | Define TypeScript interfaces, refactor Zustand slices to use provider dispatcher |
| SQLite adapter with migrations | Phase 2.3 (Week 1-2) | Introduce Drizzle/Watermelon schema, write migration harness, migrate existing local data |
| Cloud sync provider + queue | Phase 2.3 (Week 3-4) | Build sync queue, integrate React Query, implement optimistic updates |
| Mode toggle UX + migrations | Phase 2.3 (Week 5-6) | Create settings UI, implement switch flows, add analytics for mode adoption |

## Testing & Observability
- **Unit**: Provider contract tests covering hydrate/persist/migrate across adapters.
- **Integration**: Detox flows that toggle modes, force offline interactions, and verify data after reconnect.
- **API**: Contract tests ensuring version checks and conflict responses behave as expected.
- **Telemetry**: Capture sync latency, queue size, and failure counts in mobile analytics to monitor reliability.

## Open Questions
1. Should encrypted fields (e.g., receipts, notes) be stored in SQLite or kept in secure key/value storage alongside references?
2. What’s the retention policy for local data when a user signs out of cloud mode—immediate wipe or grace period?
3. Do we need background sync via Expo Task Manager prior to enabling mode switching, or is foreground sync sufficient for MVP?

## References
- `docs/planning/ROADMAP.md` – Phase 2.3 outlines cloud integration milestones.
- `docs/planning/PHASE_2_API_DEVELOPMENT_PLAN.md` – Detailed API and sync plan.
- `docs/Testing/TESTING_STRATEGY.md` – Testing expectations per surface.
