# Local and Cloud Storage Strategy

_Last updated: August 13, 2026_

## Decision

The mobile application is an offline-first client. It has durable on-device
storage and may also replicate records to cloud storage. Local and cloud
records implement one canonical domain contract; they are not independent
mobile and API expense models.

Normative behavior is defined in:

- `openspec/specs/offline-first-sync/spec.md`
- `openspec/specs/expense-ledger/spec.md`
- `openspec/specs/group-collaboration/spec.md`

## Implementation Status

The canonical single-payer expense shape, stable expense and custom-category
IDs, AsyncStorage-backed mobile snapshots, personal/shared space discriminator,
API-persisted per-space cloud policy, payload-safe idempotent expense/category
create, optimistic expense versioning, tombstones, personal-ledger projection,
currency-bucketed statistics, and API incremental expense feed are implemented
in the current change.

The transactional local repository, per-space mobile category/space catalog,
ordered durable outbox/inbox, mobile HTTP and authentication adapter,
background retry/backoff, conflict-resolution UI, server
acknowledgements/garbage collection, local-identity/account adoption mapping,
and SQLite adapter are target capabilities, not claims about the current mobile
runtime. Until those land, the two replicas do not form an end-to-end
production sync system.

## Current Data Flow

```text
React Native screens ↔ hydrated Zustand state ↔ AsyncStorage snapshots

NestJS API ↔ PostgreSQL

Mobile DTO/feed mappers exist, but no authenticated HTTP sync coordinator joins
the two paths yet.
```

## Target Data Flow

```text
React Native screens
        ↓
Zustand UI/query state
        ↓
Local repository ── durable outbox ── NestJS API ── PostgreSQL
        ↑                                  │
        └──────── incremental inbox ───────┘
```

In the target architecture, Zustand is replaceable in-memory state hydrated
from a transactional local repository. In the current runtime, Zustand persist
serializes coalesced snapshots directly to AsyncStorage; accepted expense form
submissions await that write before reporting success.

## Target Storage Responsibilities

### On-device store

- Accepts mutations immediately, including while offline.
- Retains stable IDs, versions, tombstones, sync status, and outbox operations.
- Serves all mobile reads so connectivity is not required for normal use.
- Holds authoritative records for a `local_only` personal space.
- Holds local replicas of records in a `cloud_sync` space.

AsyncStorage is the initial snapshot-backed adapter already available in the
mobile dependency set. SQLite is the required successor before large-history
or high-volume incremental sync is considered production-ready; changing the
adapter must not change domain types or UI calculations.

### Cloud store

- Persists cloud-synchronized personal spaces and every shared space.
- Enforces account membership, mutation capability, money, allocation, and
  same-space constraints.
- Deduplicates mutation retries by stable client mutation ID.
- Rejects stale versions instead of silently overwriting another device.
- Publishes ordered upserts and tombstones for incremental device sync.

## Policy Is Per Space

| Space kind | Allowed policy               | Reason                                                                     |
| ---------- | ---------------------------- | -------------------------------------------------------------------------- |
| Personal   | `local_only` or `cloud_sync` | The owner may choose device-only storage or cloud backup/multi-device use. |
| Shared     | `cloud_sync` only            | Multiple accounts and devices require one convergent cloud history.        |

A single user-wide `persistenceMode` cannot represent a local-only personal
ledger alongside cloud-synchronized shared spaces. Existing user-setting fields
with that shape are compatibility metadata until callers migrate to space
policy.

Moving a synchronized personal space to `local_only` is a replication-policy
change, not a delete request. The client must hold a complete durable snapshot
before stopping sync; retained cloud history is removed only through a separate,
explicit deletion lifecycle. Because that handoff/acknowledgement flow is not
implemented yet, the current API rejects a `cloud_sync` → `local_only`
transition with `SYNC_POLICY_HANDOFF_REQUIRED` instead of pretending the
downgrade is safe.

## Canonical Record Metadata

Each syncable aggregate carries:

- a client-generated stable record ID;
- a client mutation ID for idempotent create/retry;
- a monotonically increasing server version;
- `createdAt` and `updatedAt` timestamps;
- a versioned deletion tombstone when deleted;
- local-replica sync status: `pending`, `syncing`, `synced`, `conflict`, or
  `failed`.

Financial amounts use integer minor units. Local and cloud adapters may encode
large integers differently, but neither adapter may round or pass values
through an unsafe JavaScript number boundary.

## Target Write and Sync Protocol

The following is the required end state. Only the local snapshot commit,
server-side idempotency/version checks, and incremental feed primitives exist
today; the durable outbox/inbox orchestration is not implemented yet.

1. Validate and construct one canonical aggregate.
2. Atomically write the aggregate and outbox operation locally.
3. Update UI state from the committed local record.
4. Dispatch the outbox operation when connectivity permits.
5. Let the API deduplicate creates and compare expected versions for updates.
6. Apply the accepted server record locally and mark the operation synced.
7. Pull later remote changes after the last durable cursor.
8. Advance the cursor only after the complete inbox batch is durable.

If the cloud rejects a stale mutation, the client retains both its local intent
and the current server representation until a deterministic merge or explicit
user resolution completes. Financial allocations are never auto-merged by
adding totals.

## Personal Ledger Projection

Shared expenses are not copied into a second personal table. The personal view
is computed from:

```text
personal-space expenses
+ shared-space expenses where the user has a payment or share
```

For each expense:

```text
myPaid    = sum(my payment allocations)
mySpent   = sum(my share allocations)
myBalance = myPaid - mySpent
```

This projection must be identical on mobile and API.

## Migration Notes

- `Couple` is a legacy persistence name for the space table. New contracts use
  `spaceId` and `personal | shared`; physical renaming is a later compatibility
  migration and is not required to expose the correct domain now.
- Legacy mobile `amount`, `paidBy`, `splitBetween`, and `participants` values
  require a one-time local normalization into minor-unit payments and shares.
- Records without stable IDs must receive IDs locally before first upload; the
  server must preserve them.
- Linking a device-only personal space to an account still needs an adoption
  transaction or deterministic ID mapping before mobile may upload its local
  `spaceId`, participant IDs, and category IDs.
- The mobile label `Group` represents a shared Space. API `ExpenseGroup` is an
  optional nested collection and must not be used as that shared-space ID.
- Hard deletion is not a sync signal. Existing soft-delete data is converted to
  versioned tombstones during cloud migration.

## Required Verification

- Provider contract tests SHALL cover restart hydration and outbox durability.
- Projection tests SHALL cover paid versus spent semantics and cent-level remainder.
- API tests SHALL cover idempotent retry, stale-version conflict, authorization, and
  same-space constraints.
- PostgreSQL-only migration and trigger tests SHALL run only against an explicitly
  disposable `TEST_DATABASE_URL`.
