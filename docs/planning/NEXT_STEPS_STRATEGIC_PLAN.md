# Strategic Mobile-First API Completion Plan

_Created: September 26, 2025 (Revised)_
_Status: READY FOR EXECUTION_
_Methodology: BDD → SpecDD → TDD (Red→Green→Refactor)_

## Executive Summary

**Goal**: Complete mobile-compatible API implementation enabling seamless local-only to cloud-sync transition.
**Current Status**: Authentication pillar delivered (123/123 backend suites passing); remaining feature APIs ~35% complete with user settings and sync flows outstanding.
**Timeline**: 4 focused days to reach production-ready API with full mobile integration.
**Approach**: Lock in the finished auth foundation, ship user settings via strict TDD next, then march across category, participant/group, expense, and migration capabilities with continuous mobile contract validation.

## Current Status Analysis

### ✅ COMPLETED (Stable)

- **Mobile App**: 294/294 tests passing; feature complete in local-only mode.
- **Database Schema**: 33/33 tests passing; migrations, triggers, and constraints verified.
- **Authentication + Persistence Toggle**: `/auth` suite fully green (13/13 isolated tests) including `PUT /auth/settings/persistence`; responses match mobile contracts and meet <100 ms target.
- **Documentation Backbone**: Storage strategy, database schema, and TDD playbooks aligned on mobile-first design principles.

### 🔧 IN PROGRESS (Requires Focus)

- **User Settings API (beyond auth)**: Profile, notification, and device tracking endpoints not yet implemented; blocking full settings sync.
- **Integration Harness Hardening**: Need shared fixtures for device + mode transitions to unlock broader endpoint coverage.
- **Mobile Contract Validation**: Only auth payloads validated against mobile TypeScript interfaces; other domains pending.

### 🚧 PENDING (Next Waves)

- Category CRUD & sync (name-based lookup, default set alignment).
- Participant & group management (ID preservation, membership diffs).
- Expense CRUD + splits (cents↔dollars conversion, conflict handling).
- Data migration workflows for local → cloud bootstrap.
- End-to-end mobile/API integration regression suite.

## BDD Acceptance Criteria

**Given** a feature-complete mobile app (294/294 tests) and production-ready schema (33/33 tests),
**When** the cloud-sync API is implemented via strict TDD with mobile-first contracts,
**Then** the mobile client can switch between persistence modes without data loss while all API operations respond within <500 ms and mirror the mobile interfaces exactly.

## Implementation Plan (4 Days Total)

### IMMEDIATE PRIORITY: User Settings API (0.5 day)

**Objective**: Extend beyond `/auth/settings/persistence` to deliver complete settings management.

**TDD Cycle**:

- **RED**: Add failing tests covering profile fetch/update, notification toggles, and device registration tied to persistence mode history.
- **GREEN**: Implement controller/service logic with explicit mobile response shapes and validation parity.
- **REFACTOR**: Centralize error handling via shared filters to keep mobile error codes consistent.

**Outcome**: Settings contract unblocks downstream mobile sync toggles and device-aware migrations.

### PHASE 1: Core Foundation APIs (1.5 days)

#### 1.1 Category API (0.5 day)

- **BDD Scenario**: Couples manage categories with exact `{id,name,color}` payloads.
- **Mobile Requirements**: Name uniqueness per couple, hex color validation, default categories surfaced.
- **TDD Steps**: Failing mobile-format tests → implement service/controller → refactor queries + DTO mappers.

#### 1.2 Participants & Groups API (0.5 day)

- **BDD Scenario**: Manage participants and shared groups with stable IDs.
- **Mobile Requirements**: Preserve display names, return participant arrays inline with group payloads, respect soft deletes.
- **TDD Steps**: Write failing CRUD + membership coverage → implement services with transactional writes → optimize membership lookups.

#### 1.3 Device Sync Touchpoints (0.5 day)

- **Focus**: Device registration, last sync metadata, persistence mode stamps.
- **Reasoning**: Aligns with storage strategy for mode switching and conflict detection.
- **TDD Steps**: Add failing integration tests around device lifecycle → implement controller/service → refactor shared DTOs.

### PHASE 2: Expense Engine (1.5 days)

#### 2.1 Expense CRUD & Splits (1 day)

- **Mobile Transformations**: Dollars↔cents, category name↔UUID, ISO dates→TIMESTAMPTZ, `splitBetween` arrays→`expense_splits`.
- **TDD Sequence**: Start with failing create/read tests mirroring mobile fixtures → implement conversions + validation → add update/delete + pagination.
- **Risk Controls**: Enforce split balance trigger expectations, ensure optimistic concurrency columns respected.

#### 2.2 Analytics & Statistics (0.5 day)

- **Scope**: `/expenses/statistics` endpoints used by mobile insights, ensuring <2 s response under load.
- **TDD Steps**: Contract tests using seeded datasets → implement aggregate queries with indexes → refactor for performance.

### PHASE 3: Migration & Integration (1 day)

#### 3.1 Local→Cloud Migration API (0.5 day)

- **BDD Scenario**: Import local snapshot, remap IDs, record sync versions.
- **TDD Steps**: Failing bulk import tests with mobile export fixtures → implement transformation pipeline → add rollback guards.

#### 3.2 Mobile Integration Validation (0.5 day)

- **Objective**: Run end-to-end suites comparing API responses against mobile TypeScript interfaces.
- **TDD Steps**: Build contract harness → iterate until all paths pass → capture performance metrics.

## Technical Implementation Strategy

### Mobile-First Design Principles

1. **Interface Fidelity**: Responses mirror mobile interfaces; no extra fields.
2. **Transparent Conversion**: Monetary, date, and identifier translations handled server-side.
3. **Consistent Errors**: `{success:boolean,data?,error?}` with codes `VALIDATION_ERROR | NOT_FOUND | CONFLICT | UNAUTHORIZED`.
4. **Offline Alignment**: Endpoints support queued writes and conflict metadata for sync flows.

### Mobile-Compatible Error Response Format

```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    field?: string;
    code?: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'UNAUTHORIZED';
  };
}
```

### Data Transformation Requirements

```typescript
// Mobile → API conversions handled transparently
// Amount: 25.50 (dollars) → 2550 (cents)
// Category: "Food & Dining" → UUID foreign key
// Date: "2025-09-26T10:00:00.000Z" → TIMESTAMPTZ
// Splits: ["participant1","participant2"] → expense_splits rows with share_cents
```

## Success Criteria

### Technical Metrics

- 100% API endpoint coverage with passing TDD suites.
- <500 ms average response for CRUD endpoints; <100 ms for auth/validation checks.
- Contract harness validates every response against mobile TypeScript definitions.
- Mode switching flows verified with device history and migration rollback paths.

### Business Outcomes

- Seamless local-only ↔ cloud-sync toggles without data loss.
- Expense collaboration parity with existing mobile UX.
- Migration tooling ready for production beta.
- Confidence to enable multi-device sync for first customer cohort.

## Risk Mitigation Strategy

### High-Priority Risks & Responses

1. **Settings Scope Creep**: Constrain initial delivery to profile, notifications, device context; defer non-blocking preferences.
2. **Mobile Contract Drift**: Use shared fixtures from mobile repo; run contract tests in CI.
3. **Expense Split Bugs**: Leverage database trigger plus service-level validation; add regression tests for rounding edge cases.
4. **Migration Failures**: Implement idempotent import steps with staging tables and rollback hooks.

### Mitigation Tactics

- **Start Small**: Finish user settings to validate auth foundation.
- **Validate Early**: Run contract harness after each controller lands.
- **Guard Performance**: Capture latency metrics in tests; fail fast if thresholds exceeded.
- **Document Decisions**: Update session summaries and changelog after each milestone to keep plans synchronized.

## Next Immediate Actions

1. 🚀 Add RED tests for user settings/profile/device flows; unblock GREEN implementation.
2. 📱 Share mobile fixtures for settings/category endpoints; bake into integration tests.
3. 🔧 Stand up shared DTO/mapper layer for mobile-aligned responses before category work.
4. 🧪 Schedule contract harness run post-settings to baseline metrics ahead of category/expense sprints.

## File Organization for Implementation

### Test Files (write first)

```
src/__tests__/api/integration/
├── user-settings.spec.ts              # Profile, notifications, device lifecycle
├── category-mobile-compat.spec.ts     # Category CRUD mobile contract
├── participant-group.spec.ts          # Participant + group flows
├── expense-sync.spec.ts               # Expense CRUD + splits + pagination
├── migration-flow.spec.ts             # Local snapshot import/export
└── mobile-contract.e2e.spec.ts        # Cross-layer contract harness
```

### Implementation Files (after tests go red)

```
src/controllers/
├── user-settings.controller.ts
├── category.controller.ts
├── participant.controller.ts
├── expense.controller.ts
└── migration.controller.ts

src/services/
├── user-settings.service.ts
├── category.service.ts
├── participant.service.ts
├── expense.service.ts
└── migration.service.ts
```

## Strategic Notes

**Why This Plan Works**

- Builds directly on the polished TDD roadmap (auth → settings → categories → expenses → migration).
- Keeps mobile-first principles front-and-center, preventing contract drift.
- Uses risk-driven sequencing: address settings/device context before higher-risk expense logic.
- Ensures every deliverable lands with measurable tests and performance budgets.

**Key Coordination Points**

- Sync with mobile team on fixtures/interfaces before each phase.
- Update changelog and session summary at the end of every milestone to maintain documentation integrity.
- Track progress via passing suite counts (aim: sustain 123/123 suites, extend as new tests added).

---

**Ready for Execution**: Authentication foundation is stable; this revised plan targets user settings next and charts a TDD-driven path through the remaining APIs to unlock cloud-sync for the mobile app.
