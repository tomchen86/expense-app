# Task 2.2 API Endpoints Implementation Plan

_Created: September 27, 2025_
_Based on: CURRENT_STATUS_AND_NEXT_STEPS.md, api-group-route-migration.md, api-device-route-migration.md_

## Executive Summary

**Status**: 75% Complete → Target: 100% Complete
**Remaining Work**: 4 major deliverables + validation/polish
**Estimated Timeline**: 1-2 weeks for full completion

## Implementation Sequence (Following Recommended Order)

### 🔥 **Step 1: Couples + Devices Controllers (NEW) - Week 1**

_Priority: Critical - Blocks multi-user functionality and persistence mode switching_

#### 1.1 Couple Management Controller (NEW)

**File**: `src/controllers/couple.controller.ts`

**Missing Endpoints**:

```typescript
POST   /api/couples                 // Create couple relationship (send invitation)
GET    /api/couples/current         // Get current user's couple info
PUT    /api/couples/accept/:inviteId // Accept couple invitation
DELETE /api/couples/current         // Remove couple relationship
GET    /api/couples/invitations     // List pending invitations
```

**DTOs Required**:

```typescript
interface CreateCoupleDto {
  partner_username: string;
  message?: string;
}

interface CoupleInvitationDto {
  id: string;
  from_user: UserDto;
  message: string;
  created_at: Date;
}
```

**Service Implementation**:

- Create `src/services/couple.service.ts`
- Implement invitation lifecycle management
- Handle couple membership and role management
- Integration with existing participant system

**Test Requirements**:

- Integration tests for complete invitation flow
- Error handling for duplicate invitations
- Couple membership validation

#### 1.2 Device Management Controller (NEW)

**File**: `src/controllers/device.controller.ts`

**Canonical Endpoints** (per api-device-route-migration.md):

```typescript
POST   /api/devices                    // Register device + persistence context
GET    /api/devices                    // List devices for current user
PUT    /api/devices/:deviceUuid/sync   // Update sync heartbeat + snapshot hash
DELETE /api/devices/:deviceUuid        // Remove device registration
```

**Backward Compatibility Aliases**:

```typescript
// Maintain these during migration period
POST   /api/users/settings/devices
GET    /api/users/settings/devices
PUT    /api/users/settings/devices/:deviceUuid
DELETE /api/users/settings/devices/:deviceUuid
```

**DTOs Required**:

```typescript
interface RegisterDeviceDto {
  deviceUuid: string;
  deviceName?: string;
  platform?: 'ios' | 'android' | 'web';
  appVersion?: string;
  persistenceMode: 'local_only' | 'cloud_sync';
}

interface DeviceSyncUpdateDto {
  lastSnapshotHash?: string;
  syncStatus?: 'idle' | 'syncing' | 'error';
  lastError?: string;
  persistenceModeAtSync?: 'local_only' | 'cloud_sync';
}
```

**Service Implementation**:

- Create `src/services/device.service.ts`
- Device registration and lifecycle management
- Sync status tracking and heartbeat management
- Persistence mode transition support

**Test Requirements**:

- Device registration/update/removal flows
- Sync status management validation
- Alias route compatibility testing

### 🔥 **Step 2: Analytics Controller (NEW) - Week 1**

_Priority: High - Required for mobile insights screen functionality_

#### 2.1 Analytics & Insights Controller (NEW)

**File**: `src/controllers/analytics.controller.ts`

**Missing Endpoints**:

```typescript
GET /api/analytics/summary?period=month     // Monthly/yearly summaries
GET /api/analytics/categories?period=month  // Category breakdowns
GET /api/analytics/trends?months=6          // Spending trends
GET /api/analytics/balance                  // User balance calculations
```

**DTOs Required**:

```typescript
interface AnalyticsSummaryDto {
  period: string;
  total_amount: number;
  expense_count: number;
  average_per_expense: number;
  category_breakdown: CategoryBreakdownDto[];
  user_breakdown: UserBreakdownDto[];
}

interface CategoryBreakdownDto {
  category: CategoryDto;
  total_amount: number;
  expense_count: number;
  percentage: number;
}

interface AnalyticsQueryDto {
  period?: 'week' | 'month' | 'quarter' | 'year';
  months?: number;
  start_date?: string;
  end_date?: string;
}
```

**Service Implementation**:

- Create `src/services/analytics.service.ts`
- Expense aggregation and calculation logic
- Category breakdown computations
- Spending trend analysis algorithms
- User balance calculation (who owes what)

**Performance Requirements**:

- Target: <2 seconds for complex analytics queries
- Database query optimization with proper indexing
- Caching strategy for expensive calculations

**Test Requirements**:

- Analytics calculation accuracy tests
- Performance benchmarks for large datasets
- Various time period and filter combinations

### 🔥 **Step 3: Expense Extensions - Week 2**

_Priority: Medium - Enhances existing functionality_

#### 3.1 Receipt Upload Functionality

**Missing Endpoint**:

```typescript
POST /api/expenses/:id/receipt          // Upload receipt image
```

**Implementation**:

- File upload middleware (multer or similar)
- Image validation and processing
- Storage integration (local/cloud)
- Expense attachment linking

#### 3.2 Expense Statistics Enhancement

**Missing Endpoint**:

```typescript
GET / api / expenses / statistics; // Get expense analytics
```

**Response Structure**:

```typescript
interface ExpenseStatisticsDto {
  total_expenses: number;
  total_amount: number;
  monthly_average: number;
  category_breakdown: CategorySummaryDto[];
  recent_trends: MonthlyTrendDto[];
}
```

### 🔥 **Step 4: Validation & Polish - Week 2**

_Priority: Low - Quality assurance and completeness_

#### 4.1 User Management Completion

**Missing Endpoints**:

```typescript
GET /api/users/search?q=username        // Search users for couple pairing
```

**Implementation**:

- User search with pagination
- Privacy-safe search results
- Integration with couple invitation system

#### 4.2 Category Management Validation

**Missing Endpoint**:

```typescript
GET /api/categories/default             // Get default system categories
```

**Implementation**:

- Default category set endpoint
- Seeding integration
- Mobile compatibility validation

#### 4.3 API-Wide Consistency

- Validate all endpoints use consistent `{ success, data, error }` envelope
- Ensure proper error codes and messages
- Performance optimization and caching
- Security audit (rate limiting, validation)

## Detailed Implementation Specifications

### Database Requirements (Already Complete)

- ✅ All required tables exist (couples, participants, devices, etc.)
- ✅ Proper indexes and constraints in place
- ✅ Soft delete support where needed

### Authentication & Authorization

- ✅ JWT authentication working
- ✅ Route protection with guards
- ✅ User context available in controllers

### API Response Standards

**Success Response Format**:

```typescript
{
  "success": true,
  "data": {
    // Endpoint-specific data
  },
  "meta"?: {
    "pagination"?: PaginationMeta,
    "filters"?: any
  }
}
```

**Error Response Format**:

```typescript
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "field"?: "field_name",
    "details"?: any
  }
}
```

### Testing Requirements

#### Integration Tests (Priority)

- All new endpoints with success/error scenarios
- Authentication flow validation
- Data consistency verification
- Performance benchmarks

#### Test Structure

```
src/__tests__/api/integration/
├── couple-management.spec.ts        // NEW
├── device-management.spec.ts        // NEW
├── analytics-insights.spec.ts       // NEW
├── expense-extensions.spec.ts       // UPDATE
├── user-search.spec.ts              // NEW
└── api-consistency.spec.ts          // NEW
```

## Risk Assessment & Mitigation

### High Risk Areas

1. **Couple Management Logic** - Complex invitation and membership workflows
   - Mitigation: Comprehensive test coverage, gradual rollout

2. **Analytics Performance** - Complex aggregations on large datasets
   - Mitigation: Database optimization, caching, performance monitoring

3. **Device Sync Complexity** - Multi-device state management
   - Mitigation: Clear state machine design, extensive testing

### Medium Risk Areas

1. **File Upload Security** - Receipt image handling
   - Mitigation: File validation, size limits, virus scanning

2. **Data Migration** - Backward compatibility during route changes
   - Mitigation: Alias maintenance, phased rollout

## Success Criteria

### Technical Completion

- [ ] All 4 new controllers implemented with full CRUD operations
- [ ] All missing endpoints functional with proper validation
- [ ] Integration tests covering 95%+ of new functionality
- [ ] Performance targets met (<500ms simple, <2s complex)
- [ ] Security audit passed

### Business Functionality

- [ ] Multi-user expense sharing fully functional
- [ ] Device persistence mode switching operational
- [ ] Mobile insights screen data available
- [ ] Receipt upload and attachment workflow complete
- [ ] User search and couple pairing functional

### Quality Assurance

- [ ] API response consistency across all endpoints
- [ ] Error handling standardized
- [ ] Documentation updated and accurate
- [ ] Backward compatibility maintained during migration

## Timeline & Dependencies

### Week 1 Focus

- **Days 1-2**: Couple Management Controller + Service + Tests
- **Days 3-4**: Device Management Controller + Service + Tests
- **Day 5**: Analytics Controller implementation start

### Week 2 Focus

- **Days 1-2**: Complete Analytics + Service + Tests
- **Days 3-4**: Expense extensions (receipt upload, statistics)
- **Day 5**: User search, category defaults, final validation

### Dependencies

- ✅ Database schema complete (no blockers)
- ✅ Authentication system functional
- ✅ Existing services can be extended
- ⚠️ File storage strategy needed for receipt uploads

## Post-Implementation Tasks

1. **Mobile Integration Testing** - Validate API compatibility with mobile app
2. **Performance Optimization** - Query optimization and caching implementation
3. **Documentation** - Update API docs and integration guides
4. **Monitoring** - Add logging and metrics for new endpoints
5. **Security Review** - Comprehensive security audit of new functionality

---

_This plan provides a structured approach to completing Task 2.2 API implementation, following the recommended sequencing and addressing all identified gaps from the Phase 2 audit._
