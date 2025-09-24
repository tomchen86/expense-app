# Task 2.2: API Endpoints Implementation - Plan

**Parent Phase**: Phase 2 - API Development & Integration
**Task Duration**: 3-4 days
**Dependencies**: Task 2.1 (Database Design) must be completed
**Prerequisites**: NestJS knowledge, TypeORM setup

## Task Overview

Implement complete RESTful API endpoints for all expense tracking functionality. Create controllers, services, and DTOs that support the mobile app's current feature set while enabling multi-user capabilities.

## Detailed Subtasks

### 2.2.1 User Management Endpoints

**Duration**: 4-6 hours
**Output**: User authentication and profile management

#### User Controller (`/api/users`)

```typescript
// GET /api/users/profile - Get current user profile
// PUT /api/users/profile - Update user profile
// POST /api/users/avatar - Upload user avatar
// GET /api/users/search?q=username - Search users for couple pairing
// GET /api/users/settings - Fetch user settings (includes persistence preference)
// PUT /api/users/settings/persistence - Update storage mode preference (local_only or cloud_sync)
```

#### DTOs Required

```typescript
interface UpdateUserProfileDto {
  username?: string;
  full_name?: string;
  timezone?: string;
  currency_preference?: string;
}

interface UserSearchDto {
  query: string;
  limit?: number;
}

interface UpdatePersistenceSettingsDto {
  persistence_mode: 'local_only' | 'cloud_sync';
  device_id?: string;
}
```

### 2.2.2 Couple Management Endpoints

**Duration**: 3-4 hours
**Output**: Couple relationship management

#### Couple Controller (`/api/couples`)

```typescript
// POST /api/couples - Create couple relationship (send invitation)
// GET /api/couples/current - Get current user's couple info
// PUT /api/couples/accept/:inviteId - Accept couple invitation
// DELETE /api/couples/current - Remove couple relationship
// GET /api/couples/invitations - List pending invitations
```

#### DTOs Required

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

### 2.2.3 Category Management Endpoints

**Duration**: 2-3 hours
**Output**: Expense category CRUD operations

#### Category Controller (`/api/categories`)

```typescript
// GET /api/categories - List couple's categories
// POST /api/categories - Create new category
// PUT /api/categories/:id - Update category
// DELETE /api/categories/:id - Delete category (if no expenses)
// GET /api/categories/default - Get default system categories
```

#### DTOs Required

```typescript
interface CreateCategoryDto {
  name: string;
  color: string; // Hex color code
  icon?: string;
}

interface UpdateCategoryDto {
  name?: string;
  color?: string;
  icon?: string;
}
```

### 2.2.4 Expense Management Endpoints

**Duration**: 6-8 hours
**Output**: Core expense tracking functionality

#### Expense Controller (`/api/expenses`)

```typescript
// GET /api/expenses - List couple's expenses with pagination/filtering
// POST /api/expenses - Create new expense
// GET /api/expenses/:id - Get expense details
// PUT /api/expenses/:id - Update expense
// DELETE /api/expenses/:id - Delete expense (soft delete)
// GET /api/expenses/statistics - Get expense analytics
// POST /api/expenses/:id/receipt - Upload receipt image
```

#### Query Parameters for GET /api/expenses

```typescript
interface ExpenseQueryDto {
  page?: number;
  limit?: number;
  category_id?: string;
  paid_by?: string;
  start_date?: string;
  end_date?: string;
  min_amount?: number;
  max_amount?: number;
  search?: string;
}
```

#### DTOs Required

```typescript
interface CreateExpenseDto {
  amount: number;
  description: string;
  category_id: string;
  expense_date: string;
  split_type: 'equal' | 'custom' | 'percentage';
  splits: ExpenseSplitDto[];
  notes?: string;
}

interface ExpenseSplitDto {
  user_id: string;
  amount?: number;
  percentage?: number;
}

interface ExpenseStatisticsDto {
  total_expenses: number;
  total_amount: number;
  monthly_average: number;
  category_breakdown: CategorySummaryDto[];
  recent_trends: MonthlyTrendDto[];
}
```

### 2.2.5 Analytics and Insights Endpoints

**Duration**: 3-4 hours
**Output**: Data analysis for mobile insights screen

#### Analytics Controller (`/api/analytics`)

```typescript
// GET /api/analytics/summary?period=month - Get expense summary
// GET /api/analytics/categories?period=month - Category breakdown
// GET /api/analytics/trends?months=6 - Spending trends
// GET /api/analytics/balance - User balance calculation
```

#### DTOs Required

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
```

### 2.2.6 Device Sync & Persistence Endpoints

**Duration**: 3 hours
**Output**: APIs enabling dual persistence and device tracking

#### Device Controller (`/api/devices`)

```typescript
// POST /api/devices - Register device + persistence context
// PUT /api/devices/:id/sync - Update sync heartbeat + snapshot hash
// DELETE /api/devices/:id - Remove device registration (logout / local-only switch)
```

#### Persistence Considerations

- `POST /api/devices` should accept local-only registrations to capture analytics without forcing sync.
- `PUT /api/devices/:id/sync` stores last sync timestamps and errors for cloud mode.
- Operations must be idempotent to support offline retries.

#### DTOs Required

```typescript
interface RegisterDeviceDto {
  device_uuid: string;
  device_name?: string;
  platform?: 'ios' | 'android' | 'web';
  app_version?: string;
  persistence_mode: 'local_only' | 'cloud_sync';
}

interface DeviceSyncUpdateDto {
  last_snapshot_hash?: string;
  sync_status?: 'idle' | 'syncing' | 'error';
  last_error?: string;
  persistence_mode?: 'local_only' | 'cloud_sync';
}
```

## Implementation Architecture

### Service Layer Structure

```typescript
// UserService - User profile and search functionality
// CoupleService - Relationship management and invitations
// CategoryService - Category CRUD with validation
// ExpenseService - Core expense operations and calculations
// AnalyticsService - Data aggregation and insights
// NotificationService - Couple invitations and updates
// DeviceService - Device registration, persistence mode management, sync telemetry
```

### Validation and Security

- Input validation using class-validator decorators
- Authorization guards ensuring users only access their couple's data
- Rate limiting on expensive operations (analytics, search)
- File upload validation for receipts and avatars
- Enforce persistence preference transitions (local → cloud) with additional confirmation and device context

### Error Handling

```typescript
// Custom exception filters for:
// - CoupleNotFound
// - ExpenseNotFound
// - UnauthorizedCoupleAccess
// - InvalidSplitCalculation
// - CategoryInUse
```

## API Response Standards

### Success Response Format

```typescript
interface ApiResponse<T> {
  success: true;
  data: T;
  meta?: {
    pagination?: PaginationMeta;
    filters?: any;
  };
}
```

### Error Response Format

```typescript
interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}
```

## Implementation Steps

### Step 1: Core Infrastructure

1. Set up base controller structure
2. Implement authentication guards
3. Create common DTOs and interfaces
4. Set up validation pipes

### Step 2: User and Couple Management

1. Implement user profile endpoints
2. Create couple relationship logic
3. Add invitation system
4. Test user flows

### Step 3: Category and Expense APIs

1. Build category CRUD operations
2. Implement expense management
3. Add expense splitting logic
4. Create analytics endpoints

### Step 4: Device & Persistence APIs

1. Implement device registration and sync endpoints
2. Wire persistence preference updates to `user_settings`
3. Ensure local-only mode requests short-circuit cloud operations safely
4. Add auditing logs for persistence transitions

### Step 5: Integration Testing

1. Test all endpoint combinations
2. Validate data consistency
3. Performance test with realistic data
4. Security audit of access controls

## Success Criteria

- [ ] All endpoints respond correctly with proper data
- [ ] Authentication and authorization work properly
- [ ] Data validation prevents invalid inputs
- [ ] Performance meets <2 second response time goal
- [ ] Mobile app can successfully integrate with all endpoints
- [ ] API documentation is complete and accurate
- [ ] Persistence preference and device sync APIs support both cloud-sync and local-only flows without regressions

## Risk Mitigation

**Risk**: Complex expense splitting calculations
**Mitigation**: Extensive unit testing of split logic, validation of totals

**Risk**: Data consistency between coupled users
**Mitigation**: Database transactions, optimistic locking where needed

**Risk**: Performance issues with analytics queries
**Mitigation**: Database indexing, query optimization, caching strategy

**Risk**: Persistence mode mismatch leading to data divergence
**Mitigation**: Require explicit device context on mode changes and add integration tests for migration flows

## Files to Create/Modify

- `apps/api/src/controllers/UserController.ts`
- `apps/api/src/controllers/CoupleController.ts`
- `apps/api/src/controllers/CategoryController.ts`
- `apps/api/src/controllers/ExpenseController.ts`
- `apps/api/src/controllers/AnalyticsController.ts`
- `apps/api/src/controllers/DeviceController.ts`
- `apps/api/src/services/` (all service files)
- `apps/api/src/services/DeviceService.ts`
- `apps/api/src/dto/` (all DTO files)
- `apps/api/src/guards/CoupleAuthGuard.ts`

## Next Task Dependencies

This task enables:

- Task 2.3: Authentication Integration
- Task 2.4: Mobile API Integration
- Task 2.5: Offline Sync Implementation

## Testing Strategy

- Unit tests for all service methods
- Integration tests for controller endpoints
- End-to-end tests for complete user flows
- Load testing for analytics endpoints
- Security testing for authorization logic
- Scenario testing for persistence mode transitions and device registration lifecycle
