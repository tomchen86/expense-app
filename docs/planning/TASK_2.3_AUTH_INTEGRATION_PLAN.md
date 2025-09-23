# Task 2.3: Authentication Integration - Plan

**Parent Phase**: Phase 2 - API Development & Integration
**Task Duration**: 2-3 days
**Dependencies**: Task 2.1 (Database Design), Task 2.2 (API Endpoints)
**Prerequisites**: JWT knowledge, mobile security patterns

## Task Overview

Implement secure authentication system supporting user registration, login, and session management while preserving a fully local-only experience for users who opt out of cloud sync. Integrate with the mobile app so local profiles can upgrade to authenticated cloud accounts without losing data and align persistence flows with the dual-provider storage strategy (`docs/Storage_Strategy.md`).

## Detailed Subtasks

### 2.3.1 JWT Authentication Infrastructure
**Duration**: 3-4 hours
**Output**: JWT token management system

#### Authentication Service
```typescript
// JwtAuthService - Token generation and validation
// AuthGuard - Route protection middleware
// RefreshTokenService - Token refresh management
```

#### Token Strategy
```typescript
interface JwtPayload {
  userId: string;
  username: string;
  email: string;
  coupleId?: string;
  iat: number;
  exp: number;
}

// Access token: 15 minutes
// Refresh token: 30 days
// Rotation strategy for refresh tokens
```

### 2.3.2 Authentication Endpoints
**Duration**: 3-4 hours
**Output**: Complete auth API

#### Auth Controller (`/api/auth`)
```typescript
// POST /api/auth/register - User registration
// POST /api/auth/login - User login
// POST /api/auth/refresh - Refresh access token
// POST /api/auth/logout - Invalidate tokens
// GET /api/auth/me - Get current user info
// POST /api/auth/forgot-password - Password reset request
// POST /api/auth/reset-password - Complete password reset
```

#### DTOs Required
```typescript
interface RegisterDto {
  email: string;
  username: string;
  full_name: string;
  password: string;
  confirm_password: string;
}

interface LoginDto {
  identifier: string; // email or username
  password: string;
}

interface AuthResponseDto {
  access_token: string;
  refresh_token: string;
  user: UserDto;
  expires_in: number;
}
```

### 2.3.3 Password Security
**Duration**: 2-3 hours
**Output**: Secure password handling

#### Security Implementation
```typescript
// bcrypt for password hashing (12 rounds)
// Password strength validation
// Rate limiting for auth endpoints
// Account lockout after failed attempts
```

#### Password Requirements
- Minimum 8 characters
- At least one uppercase letter
- At least one number
- Optional special character requirement

### 2.3.4 Mobile Integration
**Duration**: 4-6 hours
**Output**: Mobile auth flow wired into persistence providers

#### Mobile Auth Store
```typescript
// Replace current internalUserId with proper authentication
// Secure token storage using device keychain/keystore
// Automatic token refresh handling
// Logout and session cleanup
// Guest mode fallback when persistence_mode === 'local_only'
// PersistenceManager consumes auth events to choose AsyncStorage vs. cloud provider
```

#### Authentication Screens (Mobile)
```typescript
// LoginScreen - Email/username and password
// RegisterScreen - Full registration form
// ForgotPasswordScreen - Password reset flow
// AuthLoadingScreen - Token validation on app start
```

### 2.3.5 Session Management
**Duration**: 2-3 hours
**Output**: Robust session handling

#### Session Features
```typescript
// Device-based session tracking
// Multiple device support per user
// Session invalidation on password change
// Automatic cleanup of expired tokens
// Graceful handling of guest sessions when persistence_mode === 'local_only'
```

#### Security Headers
```typescript
// CORS configuration for mobile app
// Rate limiting per IP and user
// Security headers (helmet.js)
// Request logging and monitoring
```

### 2.3.6 Local-Only Mode & Account Linking
**Duration**: 3 hours
**Output**: Seamless transition between guest (local) and authenticated (cloud) modes

#### Requirements
- Maintain "guest" session for users who decline authentication while keeping existing local data intact.
- Provide upgrade path: sign in → upload local snapshot → continue syncing in cloud mode.
- Allow downgrade path: authenticated user can switch back to local-only, revoking tokens and stopping sync.

#### Implementation Notes
```typescript
// guestProfileService - wraps local user state when no auth token exists
// accountLinker - orchestrates local data upload during cloud upgrade
// downgradeFlow - exports cloud data and rehydrates local stores, then revokes server sessions
// persistenceProviderRegistry - switches between AsyncStorage, SQLite, and cloud providers
```

#### UX Considerations
- Present clear messaging on data location and privacy when switching modes.
- Confirm destructive operations (e.g., deleting cloud copy when going local-only).
- Provide conflict resolution guidance if upgrade detects divergent data.

## Implementation Architecture

### Authentication Flow
```
1. User registers/logs in → JWT tokens issued
2. Mobile stores tokens securely
3. API requests include Bearer token
4. Server validates token on each request
5. Automatic refresh before expiration
6. Logout clears all stored tokens
7. Guest mode: skip token issuance; operate solely on local data until upgrade
```

### Mobile Security
```typescript
// Token Storage: Expo SecureStore
// Biometric authentication support
// Auto-lock after inactivity
// Background app state handling
```

### Database Schema Additions
*(Task 2.1 introduces these columns/tables; confirm presence before applying migrations.)*
```sql
-- Add to users table
ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NOT NULL;
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TIMESTAMP;

-- Ensure persistence preference column exists (Task 2.1)
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS persistence_mode VARCHAR(20) NOT NULL DEFAULT 'local_only';

-- Refresh tokens table
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  device_id VARCHAR(255),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  is_revoked BOOLEAN DEFAULT false
);
```

## Mobile Integration Steps

### Step 1: Auth Store Setup
1. Create new authentication store
2. Implement secure token storage
3. Add automatic refresh logic
4. Handle authentication state
5. Maintain guest session path when no credentials are present
6. Emit persistence mode change events to the persistence provider interface

### Step 2: Screen Implementation
1. Design login/register UI
2. Implement form validation
3. Add loading states and error handling
4. Create onboarding flow
5. Surface persistence mode selection during onboarding (local-only vs cloud-sync)

### Step 3: API Integration
1. Update all API calls to include auth headers
2. Handle 401 responses with token refresh
3. Implement logout functionality
4. Test authentication flows
5. Short-circuit API calls gracefully when operating in local-only mode
6. Wire sync queue to use authenticated endpoints only when persistence mode is `cloud_sync`

### Step 4: User Migration
1. Create migration from internalUserId to proper auth
2. Preserve existing user data
3. Force re-authentication on app update
4. Data consistency validation
5. Provide guided migration for local-only → cloud-sync (upload + verification)
6. Offer downgrade workflow to revert to local-only and revoke remote tokens
7. Run persistence provider migrations (AsyncStorage → SQLite) before uploading snapshot

### Step 5: Persistence Provider Rollout (depends on Task 2.2 groundwork)
1. Register AsyncStorage adapter as baseline provider
2. Implement SQLite adapter with deterministic migrations and hydrate hooks
3. Connect cloud-sync provider to queue + React Query cache
4. Add diagnostics for provider health (failed writes, pending queue size)
5. Document fallback strategy if SQLite initialization fails

## Security Considerations

### API Security
- Rate limiting: 5 requests/minute for auth endpoints
- Account lockout: 5 failed attempts = 15 minute lockout
- Password reset tokens: 1 hour expiration
- HTTPS only in production

### Mobile Security
- Biometric authentication option
- App background state protection
- Secure token storage
- Certificate pinning consideration

### Data Protection
- Password hashing with bcrypt
- No passwords in logs or responses
- User data encryption at rest
- Audit logging for auth events

## Success Criteria

- [ ] Users can register and login successfully
- [ ] JWT tokens work correctly with all API endpoints
- [ ] Mobile app maintains authentication state
- [ ] Token refresh works automatically
- [ ] Security measures prevent common attacks
- [ ] Existing user data is preserved during migration
- [ ] Local-only mode functions without authentication and supports upgrade/downgrade flows
- [ ] Persistence provider registry switches between AsyncStorage, SQLite, and cloud-sync successfully

## Risk Mitigation

**Risk**: Token security vulnerabilities
**Mitigation**: Follow JWT best practices, implement refresh rotation

**Risk**: User data loss during migration
**Mitigation**: Comprehensive backup and rollback plan

**Risk**: Mobile authentication UX issues
**Mitigation**: Extensive testing on different devices and scenarios

**Risk**: Mode switching results in data divergence or token leaks
**Mitigation**: Enforce explicit upgrade/downgrade flows with confirmations and automated backups

## Files to Create/Modify

### API
- `apps/api/src/auth/JwtAuthService.ts`
- `apps/api/src/auth/AuthController.ts`
- `apps/api/src/auth/AuthGuard.ts`
- `apps/api/src/auth/dto/` (all auth DTOs)
- `apps/api/src/entities/RefreshToken.entity.ts`

### Mobile
- `apps/mobile/src/store/authStore.ts`
- `apps/mobile/src/store/guestProfileStore.ts`
- `apps/mobile/src/screens/auth/LoginScreen.tsx`
- `apps/mobile/src/screens/auth/RegisterScreen.tsx`
- `apps/mobile/src/services/authService.ts`
- `apps/mobile/src/services/guestProfileService.ts`
- `apps/mobile/src/utils/secureStorage.ts`

## Next Task Dependencies

This task enables:
- Task 2.4: Mobile API Integration (authentication required)
- Task 2.5: Real-time sync features
- All subsequent user-specific functionality

## Testing Strategy

- Unit tests for authentication logic
- Integration tests for login/register flows
- Security testing for common vulnerabilities
- Mobile testing on iOS and Android
- Load testing for auth endpoints
- Migration testing with existing data
- Mode-switch testing covering guest ↔ cloud transitions and downgrade flows
