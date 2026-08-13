# Offline-First Sync Specification

## Purpose

Define the two-storage architecture: durable on-device storage for immediate
offline operation and PostgreSQL cloud storage for backup, multi-device use,
and collaboration. These are replicas of one domain, not independent expense
models.

## Delivery Status

The current mobile runtime durably persists hydrated Zustand snapshots and has
canonical expense DTO/feed mappers. The API currently provides stable IDs,
idempotent expense create, optimistic versions, tombstones, and an incremental
expense feed. The transactional local repository, durable outbox/inbox,
authenticated HTTP coordinator, retry/backoff, conflict UI, acknowledgement
and tombstone garbage collection, and account-link adoption transaction below
remain required target behavior; this specification does not claim that the
end-to-end synchronization loop is already delivered. Until replica handoff is
implemented, the API SHALL reject disabling cloud sync on a server-backed
personal space with `SYNC_POLICY_HANDOFF_REQUIRED`.

## Requirements

### Requirement: Durable Local Store

The mobile client SHALL commit user-visible mutations to durable local storage
before reporting success. Zustand or equivalent UI state SHALL be a hydrated
view/cache and SHALL NOT be the only persistence location. Restarting the app
SHALL restore the same records and stable local identity.

#### Scenario: App restarts offline

- GIVEN an expense was committed while offline
- WHEN the process terminates and restarts without connectivity
- THEN the expense is restored from local storage
- AND remains available for edit and later sync

### Requirement: One Logical Record Across Replicas

A syncable record SHALL use the same stable identifier in local and cloud
storage. Each replica SHALL track record version, update time, deletion
tombstone, and sync status. Downloading a cloud record SHALL upsert its local
replica rather than create a second logical record.

#### Scenario: Local record reaches the cloud

- GIVEN a locally created expense has identifier E
- WHEN its queued mutation is accepted
- THEN the cloud expense also has identifier E
- AND the local record transitions to synced state

### Requirement: Durable Outbox

Every local mutation for a cloud-synced space SHALL atomically update the local
record and append a durable outbox operation. Each operation SHALL have a
stable mutation identifier. A failed or interrupted dispatch SHALL be retried
without duplicating the cloud record.

#### Scenario: Network fails after cloud acceptance

- GIVEN the server accepts an operation but the response is lost
- WHEN the outbox retries that mutation identifier
- THEN the server returns the previously accepted result
- AND the client marks the outbox operation complete

### Requirement: Incremental Inbox Application

The client SHALL pull ordered cloud changes after its last durable cursor and
apply the complete batch transactionally to local storage. It SHALL persist
the new cursor only after all upserts and tombstones are durable.

#### Scenario: Batch application is interrupted

- GIVEN a sync batch has not been fully committed locally
- WHEN the client restarts
- THEN it retains the previous cursor
- AND safely requests or reapplies the batch

### Requirement: Sync Policy by Space

Personal spaces MAY be local-only or cloud-synchronized. Shared spaces SHALL
be cloud-synchronized. Changing a personal space from local-only to cloud sync
SHALL preserve identifiers and upload through the same idempotent outbox.
Only the space owner SHALL change storage policy.

#### Scenario: Local-only personal expense

- GIVEN the personal space policy is `local_only`
- WHEN an expense is created
- THEN it is committed locally
- AND no cloud operation is queued

#### Scenario: Owner disables personal cloud sync

- GIVEN a personal space has synchronized cloud records
- WHEN its owner changes the policy to `local_only`
- THEN the device first preserves a complete durable local replica
- AND routine synchronization stops at an acknowledged boundary
- AND neither local nor cloud history is implicitly deleted
- AND deleting the retained cloud copy requires a separate explicit action

### Requirement: Conflict Detection

The client SHALL submit the version on which an update or delete is based. The
cloud SHALL reject stale versions. The client SHALL preserve both local intent
and current cloud state until an explicit deterministic merge or user decision
resolves the conflict.

#### Scenario: Two devices edit the same field

- GIVEN both devices start from version 3
- AND device A successfully creates version 4
- WHEN device B submits its version-3 edit
- THEN the API returns a conflict
- AND device B does not silently overwrite version 4

### Requirement: Tombstone Propagation

Deletion SHALL be represented by a versioned tombstone until every relevant
replica can observe it under the retention policy. Hard deletion SHALL NOT be
used as the normal synchronization signal.

#### Scenario: Expense is deleted on another device

- GIVEN the local client last stored an active expense
- WHEN it receives a newer tombstone
- THEN the active local projection removes the expense
- AND it does not resurrect the expense on the next upload

### Requirement: Sync Observability

The client SHALL expose pending, syncing, synced, conflict, and failed states
without treating telemetry as financial truth. A user SHALL be able to retry a
failed operation and understand when shared changes have not reached the
cloud.

#### Scenario: Shared expense cannot upload

- GIVEN repeated transient upload failures
- WHEN the user views the expense or sync status
- THEN the record remains available locally
- AND the UI identifies that sharing is pending or failed
