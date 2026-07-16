# Architecture Decision Records (ADRs)

## ADR-001: Mobile Framework Selection

**Date**: 2025-08-26
**Status**: Accepted
**Deciders**: Development Team

### Context

Need to choose mobile development framework for expense tracking app targeting iOS and Android.

### Decision

React Native with Expo SDK

### Rationale

- **Code Sharing**: Single codebase for iOS/Android reduces development time by 60%
- **Team Expertise**: JavaScript/TypeScript knowledge already exists
- **Rapid Prototyping**: Expo provides managed workflow for faster iteration
- **Future Web Support**: React Native Web enables code sharing with web app

### Alternatives Considered

- **Native iOS/Android**: Rejected due to 2x development cost and maintenance burden
- **Flutter**: Rejected due to Dart learning curve and limited team expertise
- **Ionic**: Rejected due to WebView performance concerns

### Consequences

- **Positive**: Fast development, code reuse, active ecosystem
- **Negative**: Platform-specific features require native modules, bundle size considerations
- **Risks**: Expo limitations may require ejection for advanced features

---

## ADR-002: Backend Framework Selection

**Date**: 2025-08-26
**Status**: Accepted
**Deciders**: Development Team

### Context

Need scalable backend framework for multi-user expense tracking with real-time features.

### Decision

NestJS with TypeScript

### Rationale

- **Type Safety**: Full TypeScript integration eliminates runtime type errors
- **Architecture**: Decorator-based, modular structure scales well
- **Ecosystem**: Excellent TypeORM integration, built-in validation, testing support
- **Team Alignment**: JavaScript ecosystem consistency with mobile team

### Alternatives Considered

- **Express.js**: Rejected due to lack of built-in structure for larger applications
- **Django**: Rejected due to Python context switching and team expertise
- **Ruby on Rails**: Rejected due to learning curve and deployment complexity
- **Go/Gin**: Rejected due to team expertise and ecosystem maturity for this use case

### Consequences

- **Positive**: Rapid development, strong typing, excellent tooling
- **Negative**: Heavier than Express, decorator learning curve
- **Risks**: Framework lock-in, potential over-engineering for simple features

---

## ADR-003: Database Selection

**Date**: 2025-09-19
**Status**: Accepted
**Deciders**: Development Team

### Context

Need reliable database for financial data with ACID compliance and complex relational queries.

### Decision

PostgreSQL

### Rationale

- **ACID Compliance**: Financial data requires strong consistency guarantees
- **Relational Model**: Complex expense splitting relationships fit relational paradigm
- **Performance**: Excellent query performance with proper indexing
- **Ecosystem**: Strong TypeORM support, mature tooling, cloud deployment options

### Alternatives Considered

- **MongoDB**: Rejected due to lack of ACID guarantees for financial data
- **MySQL**: Rejected due to PostgreSQL's superior JSON support and feature set
- **SQLite**: Rejected due to multi-user concurrency limitations
- **DynamoDB**: Rejected due to complexity of relational queries and cost

### Consequences

- **Positive**: Data integrity, powerful querying, mature ecosystem
- **Negative**: More complex setup than NoSQL options
- **Risks**: Need proper backup strategy, index management required

---

## ADR-004: State Management Selection (Mobile)

**Date**: 2025-08-26
**Status**: Accepted
**Deciders**: Development Team

### Context

Mobile app requires complex state management for expenses, groups, categories, and offline sync.

### Decision

Zustand with AsyncStorage persistence

### Rationale

- **Simplicity**: Minimal boilerplate compared to Redux
- **TypeScript Support**: Excellent TypeScript integration
- **Bundle Size**: Significantly smaller than Redux toolkit
- **Flexibility**: Easy to implement modular store architecture

### Alternatives Considered

- **Redux Toolkit**: Rejected due to boilerplate overhead for small team
- **Context + useReducer**: Rejected due to performance concerns with frequent updates
- **MobX**: Rejected due to learning curve and debugging complexity
- **React Query**: Considered for server state but chose local-first approach

### Consequences

- **Positive**: Simple API, good performance, easy testing
- **Negative**: Less community resources than Redux
- **Risks**: May need migration if complex async state management required

---

## ADR-005: Authentication Strategy

**Date**: 2025-09-19
**Status**: Proposed
**Deciders**: Development Team

### Context

Need secure authentication for couple-based expense sharing with mobile and web support.

### Decision

JWT with Refresh Token Rotation

### Rationale

- **Stateless**: JWT enables horizontal scaling without session storage
- **Security**: Refresh token rotation mitigates token theft risks
- **Cross-Platform**: Works identically on mobile and web
- **Offline Support**: JWT validation doesn't require server connectivity

### Alternatives Considered

- **Session-Based**: Rejected due to scaling complexity and mobile limitations
- **OAuth Only**: Rejected due to complexity for direct user registration
- **Firebase Auth**: Rejected due to vendor lock-in and cost scaling
- **Supabase Auth**: Considered but JWT gives more control

### Consequences

- **Positive**: Scalable, secure, platform-agnostic
- **Negative**: Token management complexity, storage security requirements
- **Risks**: JWT size limitations, refresh token storage security

---

## ADR-006: Dual Persistence Strategy for Mobile Storage

**Date**: 2025-09-23
**Status**: Accepted
**Deciders**: Development Team

### Context

Phase 2 requires user-selectable storage modes (local-only vs cloud sync) while maintaining offline-first behaviour and minimal disruption to existing mobile code.

### Decision

Retain Zustand as the in-memory state container and introduce a pluggable persistence provider contract with three implementations: AsyncStorage/MMKV (baseline), SQLite (structured local cache), and a cloud sync provider backed by the NestJS + PostgreSQL API.

### Rationale

- **Layered responsibility**: Keeps UI and business logic independent of persistence details.
- **Incremental rollout**: Allows shipping local-only mode now and layering in SQLite/Cloud without rewrites.
- **Performance**: SQLite handles large datasets offline, while cloud provider supports multi-device consistency.
- **Maintainability**: Single contract simplifies testing and future provider additions.

### Alternatives Considered

- **Replace Zustand with SQLite/WatermelonDB**: Rejected due to higher complexity and loss of simple state management ergonomics.
- **React Query as sole state store**: Rejected because offline-first workflows still need durable local storage.
- **Cloud-only storage**: Rejected; violates offline requirement and user control over data residency.

### Consequences

- **Positive**: Clear separation of concerns, flexible storage choices, easier conflict handling.
- **Negative**: Requires investment in migration tooling and provider-specific schemas.
- **Risks**: Interface drift across providers; must maintain parity in features and migrations.

---

## ADR Template

```markdown
# ADR-XXX: [Short Title]

**Date**: YYYY-MM-DD
**Status**: [Proposed | Accepted | Deprecated | Superseded]
**Deciders**: [List of people involved]

### Context

[Describe the situation that requires a decision]

### Decision

[State the decision made]

### Rationale

[Explain why this decision was made]

### Alternatives Considered

[List other options and why they were rejected]

### Consequences

[Document expected positive and negative outcomes]
```

---

## Decision Review Process

### When to Create ADR

- Technology stack changes
- Major architectural patterns
- Infrastructure decisions
- Security/authentication approaches
- Third-party service selections

### Review Schedule

- Quarterly ADR review for relevance
- Update status when decisions change
- Archive superseded decisions with references

### Decision Criteria

1. **Team Expertise**: Can the team effectively implement and maintain?
2. **Scalability**: Will this decision support future growth?
3. **Cost**: Total cost of ownership including development and operations
4. **Risk**: What are the failure modes and mitigation strategies?
5. **Reversibility**: How difficult would it be to change this decision later?
