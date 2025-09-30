# Phase 2: API Development & Integration Plan

_Created: August 30, 2025_
_Updated: September 19, 2025_
_Phase Duration: 6-8 weeks (realistic for solo/small team)_
_Prerequisites: ✅ Phase 1 Complete (All files under 500 lines)_
_Documentation Integration: Update FUNCTION_LOG.md throughout implementation_

## Overview

Transform the local-only mobile app into a multi-user system with full backend integration. This phase establishes the foundation for couples to share expenses across devices with real-time synchronization and introduces the dual persistence strategy described in `docs/Storage_Strategy.md`.

## Phase Goals

### Primary Objectives

- **Database Foundation**: Complete PostgreSQL schema supporting multi-user expense sharing
- **API Development**: Full CRUD operations for all domain entities
- **Mobile Integration**: Introduce a pluggable persistence layer (AsyncStorage → SQLite → Cloud) so users can choose local-only or cloud-synced storage
- **Offline-First**: Maintain app functionality without internet connection

### Success Metrics

- ✅ All mobile app features work with API backend
- ✅ < 2 second API response times for core operations
- ✅ 100% data consistency between mobile and server
- ✅ Offline functionality with sync on reconnection
- ✅ User-selectable persistence setting with safe migration between modes

## Implementation Breakdown

**Follow our three-layer planning**: See TASK_2.1, TASK_2.2, TASK_2.3 for detailed implementation plans

### Weeks 1-2: Database Design & Setup (TASK_2.1)

_Focus: Establish data foundation_
_Testing: Follow TESTING_STRATEGY.md for database testing_

#### Database Schema Design

**Users Table**

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  timezone VARCHAR(50) DEFAULT 'UTC',
  currency_preference VARCHAR(3) DEFAULT 'USD',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active_at TIMESTAMP
);
```

**Couples Table**

```sql
CREATE TABLE couples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  invite_code VARCHAR(10) UNIQUE NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE couple_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID REFERENCES couples(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member', -- 'creator', 'member'
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(couple_id, user_id)
);
```

**Expense Groups Table** (maps to mobile ExpenseGroup)

```sql
CREATE TABLE expense_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID REFERENCES couples(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(7), -- hex color
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Categories Table**

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID REFERENCES couples(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  color VARCHAR(7) NOT NULL, -- hex color
  icon VARCHAR(50),
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(couple_id, name)
);
```

**Expenses Table**

```sql
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID REFERENCES couples(id) ON DELETE CASCADE,
  group_id UUID REFERENCES expense_groups(id),
  category_id UUID REFERENCES categories(id),
  created_by UUID REFERENCES users(id),

  -- Core expense data
  description VARCHAR(200) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  expense_date DATE NOT NULL,

  -- Payment tracking
  paid_by UUID REFERENCES users(id),
  split_type VARCHAR(20) DEFAULT 'equal', -- 'equal', 'custom', 'percentage'

  -- Metadata
  notes TEXT,
  receipt_url TEXT,
  location VARCHAR(200),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Expense Splits (MVP: Simple JSON field)**

```sql
-- For MVP, store splits as JSON in expenses table
-- Can be normalized to separate table in Phase 3 if needed
ALTER TABLE expenses ADD COLUMN splits JSONB DEFAULT '[]';

-- Example JSON structure:
-- [{"userId": "uuid", "amount": 25.50}, {"userId": "uuid", "amount": 25.50}]
```

**Note**: Starting with JSON for simplicity. Can normalize to `expense_splits` table in Phase 3 if advanced split features are needed.

#### Development Environment Setup

1. **Docker Compose Configuration**

   ```yaml
   # docker-compose.dev.yml
   version: '3.8'
   services:
     postgres:
       image: postgres:15
       environment:
         POSTGRES_DB: expense_tracker_dev
         POSTGRES_USER: dev_user
         POSTGRES_PASSWORD: dev_password
       ports:
         - '5432:5432'
       volumes:
         - postgres_data:/var/lib/postgresql/data

     redis:
       image: redis:7-alpine
       ports:
         - '6379:6379'

   volumes:
     postgres_data:
   ```

2. **TypeORM Configuration**
   ```typescript
   // apps/api/src/config/database.config.ts
   export const databaseConfig: TypeOrmModuleOptions = {
     type: 'postgres',
     host: process.env.DB_HOST || 'localhost',
     port: parseInt(process.env.DB_PORT) || 5432,
     username: process.env.DB_USER || 'dev_user',
     password: process.env.DB_PASSWORD || 'dev_password',
     database: process.env.DB_NAME || 'expense_tracker_dev',
     entities: ['dist/**/*.entity{.ts,.js}'],
     migrations: ['dist/migrations/*{.ts,.js}'],
     synchronize: process.env.NODE_ENV === 'development',
     logging: process.env.NODE_ENV === 'development',
   };
   ```

#### Tasks for Week 1

- [ ] Create database schema design document with ER diagram (include sync/version columns and persistence metadata)
- [ ] Set up Docker development environment
- [ ] Install and configure TypeORM in NestJS app
- [ ] Create entity classes for all domain models
- [ ] Write database migration files
- [ ] Create comprehensive seed data script
- [ ] Set up database backup and restore procedures

### Weeks 3-5: Core API Endpoints Development (TASK_2.2)

_Focus: Build complete REST API_
_Documentation: Update FUNCTION_LOG.md API implementation status_
_Testing: Implement API testing per TESTING_STRATEGY.md_

#### Authentication Endpoints

```typescript
// AuthController endpoints
POST / auth / register; // User registration
POST / auth / login; // User login
POST / auth / refresh; // Token refresh
POST / auth / logout; // User logout
GET / auth / profile; // Get current user profile
PUT / auth / profile; // Update user profile
```

#### User Management Endpoints

```typescript
// UsersController endpoints
GET / users / me; // Get current user details
PUT / users / me; // Update current user
DELETE / users / me; // Delete user account
POST / users / upload - avatar; // Upload profile picture
```

#### Couple Management Endpoints

```typescript
// CouplesController endpoints
POST   /couples           // Create new couple
GET    /couples/my        // Get user's couples
GET    /couples/:id       // Get couple details
PUT    /couples/:id       // Update couple
DELETE /couples/:id       // Delete couple
POST   /couples/join      // Join couple via invite code
POST   /couples/:id/leave // Leave couple
```

#### Expense Groups Endpoints

```typescript
// ExpenseGroupsController endpoints
GET    /couples/:coupleId/groups     // Get couple's expense groups
POST   /couples/:coupleId/groups     // Create expense group
PUT    /groups/:id                   // Update expense group
DELETE /groups/:id                   // Delete expense group
```

#### Categories Endpoints

```typescript
// CategoriesController endpoints
GET    /couples/:coupleId/categories  // Get couple's categories
POST   /couples/:coupleId/categories  // Create category
PUT    /categories/:id                // Update category
DELETE /categories/:id                // Delete category
POST   /categories/default            // Create default categories
```

#### Expenses Endpoints

```typescript
// ExpensesController endpoints
GET    /couples/:coupleId/expenses         // Get couple's expenses (paginated, filtered)
POST   /couples/:coupleId/expenses         // Create new expense
GET    /expenses/:id                       // Get expense details
PUT    /expenses/:id                       // Update expense
DELETE /expenses/:id                       // Delete expense
GET    /expenses/:id/splits               // Get expense split details
PUT    /expenses/:id/splits               // Update expense splits
POST   /expenses/:id/settle               // Mark splits as settled
```

#### Analytics Endpoints

```typescript
// AnalyticsController endpoints
GET    /couples/:coupleId/analytics/summary    // Monthly/yearly summaries
GET    /couples/:coupleId/analytics/categories // Category breakdowns
GET    /couples/:coupleId/analytics/trends     // Spending trends
GET    /couples/:coupleId/analytics/balances   // Who owes what
```

#### API Documentation & Validation

- Complete OpenAPI/Swagger documentation
- Request/response DTO classes with validation
- Error handling with proper HTTP status codes
- Rate limiting and security middleware
- Comprehensive API testing with Postman/Insomnia
- Document persistence provider contract endpoints (sync queue, conflict payloads)

#### Tasks for Weeks 2-3

- [ ] Implement authentication with JWT strategy
- [ ] Create all entity controllers with full CRUD operations
- [ ] Add comprehensive input validation with class-validator
- [ ] Implement proper error handling and logging
- [ ] Create API documentation with Swagger
- [ ] Write integration tests for all endpoints
- [ ] Add rate limiting and security headers
- [ ] Implement pagination for list endpoints
- [ ] Expose sync queue endpoints (batched writes, conflict responses) required by persistence providers

### Weeks 6-8: Mobile-API Integration (TASK_2.3)

_Focus: Add cloud sync while preserving a local-only storage option_
_Quality Assurance: Follow UPDATE_CHECKLIST.md for all integration work_
_Documentation: Update FUNCTION_LOG.md with mobile API integration status_

#### Persistence Provider Contract

```typescript
// libs/persistence/src/index.ts
export interface PersistenceProvider {
  hydrate(): Promise<PersistedSnapshot>;
  persist(changeset: PersistedChangeset): Promise<void>;
  migrate(targetVersion: number): Promise<void>;
  subscribe(listener: PersistenceListener): void;
  clear(): Promise<void>;
}

export type PersistenceMode = 'local_only' | 'cloud_sync';
```

#### API Client Setup

```typescript
// apps/mobile/src/services/api/apiClient.ts
import axios from 'axios';

export const apiClient = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for auth tokens
apiClient.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor for token refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      await handleTokenRefresh();
      return apiClient.request(error.config);
    }
    return Promise.reject(error);
  },
);
```

#### React Query Integration

```typescript
// apps/mobile/src/hooks/api/useExpenses.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export const useExpenses = (coupleId: string) => {
  return useQuery({
    queryKey: ['expenses', coupleId],
    queryFn: () => expenseService.getExpenses(coupleId),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

export const useCreateExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: expenseService.createExpense,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.setQueryData(['expense', data.id], data);
    },
  });
};
```

#### Offline-First Implementation

```typescript
// apps/mobile/src/services/offlineSync.ts
class OfflineSyncService {
  private pendingOperations: PendingOperation[] = [];

  async queueOperation(operation: PendingOperation) {
    this.pendingOperations.push(operation);
    await AsyncStorage.setItem(
      'pendingOps',
      JSON.stringify(this.pendingOperations),
    );
  }

  async syncPendingOperations() {
    if (!isOnline()) return;

    for (const operation of this.pendingOperations) {
      try {
        await this.executeOperation(operation);
        this.removePendingOperation(operation.id);
      } catch (error) {
        console.error('Sync failed for operation:', operation.id, error);
      }
    }
  }
}
```

#### Persistence Strategy

1. **Phase 1**: Extract persistence interfaces that support both local and cloud providers
2. **Phase 2**: Implement SQLite-backed local provider with deterministic migrations
3. **Phase 3**: Implement cloud-backed provider with sync queue and shared caching primitives
4. **Phase 4**: Expose user-facing toggle with guided migration flows (local → cloud, cloud → local)
5. **Phase 5**: Add background reconciliation and conflict resolution tailored to the selected mode

#### Tasks for Week 4

- [ ] Set up axios client with auth interceptors
- [ ] Integrate React Query for data fetching and caching
- [ ] Create service layer for all API calls
- [ ] Implement offline queue for pending operations
- [ ] Add optimistic updates for better UX
- [ ] Migrate Zustand stores to use persistence interfaces
- [ ] Add comprehensive error handling and retry logic
- [ ] Implement data synchronization conflict resolution
- [ ] Build persistence preference UI + settings storage
- [ ] Implement bidirectional migration flows when users switch modes
- [ ] Finalize SQLite migration scripts and fallback strategy if initialization fails
- [ ] Document mode-specific limitations and testing requirements

## Technical Architecture Decisions

### Database Technology: PostgreSQL

**Rationale**: ACID compliance, JSON support for flexible data, excellent performance, mature ecosystem.

### ORM Choice: TypeORM

**Rationale**: Full TypeScript support, decorators for clean entity definitions, migration system, NestJS integration.

### API Design: RESTful with GraphQL consideration

**Current**: REST for simplicity and quick development
**Future**: GraphQL for mobile efficiency and flexible queries

### Caching Strategy: Redis + React Query

- **Redis**: Server-side caching for expensive database queries
- **React Query**: Client-side caching with intelligent invalidation

### Authentication: JWT with Refresh Tokens

**Security Features**:

- Short-lived access tokens (15 minutes)
- Long-lived refresh tokens (30 days)
- Token rotation on refresh
- Secure HTTP-only cookie storage for refresh tokens

## Data Migration Strategy

### Mobile Data Export

```typescript
// Export existing Zustand data for migration
const exportMobileData = () => {
  const storeData = expenseStore.getState();
  return {
    expenses: storeData.expenses,
    groups: storeData.groups,
    participants: storeData.participants,
    categories: storeData.categories,
    userSettings: storeData.userSettings,
  };
};
```

### Server Import Process

1. **User Registration**: Create account and couple
2. **Data Upload**: Bulk import existing expenses via special endpoint
3. **Validation**: Verify data integrity and relationships
4. **Cleanup**: Archive or clear local storage based on persistence preference

### Reverting to Local Mode

1. **Data Export**: Download latest server state in local schema format
2. **Local Restore**: Hydrate Zustand stores and persist to AsyncStorage/SQLite
3. **Mode Switch**: Disable sync queue and background jobs
4. **Confirmation**: Prompt user to delete remote copy or keep for future sync

## Testing Strategy

### Backend Testing

- **Unit Tests**: All service methods and utility functions
- **Integration Tests**: API endpoints with test database
- **E2E Tests**: Complete user workflows via API

### Mobile Testing

- **API Integration Tests**: Mock API responses for offline scenarios
- **Data Sync Tests**: Verify local/remote data consistency
- **Offline Tests**: Ensure full functionality without network

## Performance Considerations

### Database Optimization

- **Indexing**: Proper indexes on frequently queried columns
- **Query Optimization**: Use EXPLAIN ANALYZE for slow queries
- **Connection Pooling**: Configure optimal pool size for concurrent users

### API Performance

- **Pagination**: All list endpoints with cursor-based pagination
- **Caching**: Redis caching for expensive calculations
- **Compression**: GZIP compression for API responses

### Mobile Performance

- **Data Loading**: Progressive loading with skeleton screens
- **Image Optimization**: Proper image caching and compression
- **Memory Management**: Proper cleanup of observers and timers

## Security Considerations

### API Security

- **Rate Limiting**: Prevent API abuse with request limiting
- **Input Validation**: Comprehensive validation on all inputs
- **SQL Injection Protection**: Parameterized queries via TypeORM
- **CORS Configuration**: Restrict origins in production

### Data Privacy

- **Couple Isolation**: Users can only access their couple's data
- **Audit Logging**: Track all data modifications
- **Data Encryption**: Sensitive data encryption at rest

## Risk Mitigation

### Technical Risks

1. **Data Loss During Migration**: Comprehensive backup and rollback procedures
2. **Performance Degradation**: Load testing and performance monitoring
3. **Sync Conflicts**: Conflict resolution UI and last-write-wins strategy

### Timeline Risks

1. **Database Design Complexity**: Start with MVP schema, iterate
2. **API Development Scope**: Prioritize mobile-critical endpoints first
3. **Integration Challenges**: Parallel development and early testing

## Success Criteria

### Week 1 Success

- ✅ PostgreSQL database running locally
- ✅ All entity classes created and tested
- ✅ Database migrations working
- ✅ Seed data populates complete test scenario

### Week 2-3 Success

- ✅ All mobile features accessible via API
- ✅ Authentication working end-to-end
- ✅ API documentation complete and accurate
- ✅ Integration tests passing at 95%+

### Week 4 Success

- ✅ Mobile app supports both cloud-sync and local-only modes
- ✅ Offline functionality working
- ✅ Data migration flows (local ↔ cloud) verified end-to-end
- ✅ Performance meets < 2 second response time goals

## Next Phase Preparation

### Phase 3 Prerequisites

- Authentication system fully tested
- Database schema validated with real usage
- API performance benchmarked and optimized
- Mobile integration solid and stable

## Integration with Documentation System

### Quality Assurance Integration

- **Every commit**: Follow UPDATE_CHECKLIST.md procedures
- **Feature completion**: Update FUNCTION_LOG.md implementation status (✅→🚧→📋)
- **Weekly progress**: Update session summaries with strategic insights
- **Task completion**: Create TASK_X.X_COMPLETION_LOG.md for each completed task

### Risk Management

- **Monitor risks**: Reference RISK_ASSESSMENT.md for database and API risks
- **Performance targets**: Follow PERFORMANCE_METRICS.md SLA requirements
- **Testing compliance**: Implement per TESTING_STRATEGY.md framework

### Documentation Updates Required

- [ ] **If database schema changes**: Update ARCHITECTURE_DECISION_RECORDS.md
- [ ] **If API design patterns change**: Update ARCHITECTURE.md
- [ ] **If new tools added**: Update TOOL_INTEGRATION_GUIDE.md
- [ ] **If security approach changes**: Update RISK_ASSESSMENT.md

## Success Criteria (Updated for Realistic Timeline)

### Weeks 1-2 Success (Database Foundation)

- ✅ PostgreSQL database running with proper schema
- ✅ All TypeORM entities tested and working
- ✅ Database migrations functional
- ✅ Comprehensive seed data for testing

### Weeks 3-5 Success (API Development)

- ✅ All core endpoints operational and tested
- ✅ Authentication system secure and functional
- ✅ API documentation complete and accurate
- ✅ Performance meets <2 second SLA requirements

### Weeks 6-8 Success (Mobile Integration)

- ✅ Mobile app fully integrated with API for cloud mode and stable for local-only mode
- ✅ Offline functionality working reliably in both persistence modes
- ✅ Data migration between modes successful without data loss
- ✅ All existing mobile features work regardless of selected persistence mode

---

_This document will be updated throughout implementation following our documentation update procedures in UPDATE_CHECKLIST.md_
