# User/Settings Store Refactor Plan

_Created: September 20, 2025_

## Problem Analysis

### Current Issues

1. **Type Confusion**: `UserSettings` interface only has `name: string` but tests expect `theme`, `currency`, `dateFormat`
2. **API Confusion**: Integration tests expect separate `user` and `settings` objects but store provides `userSettings`
3. **Semantic Mixing**: Store combines user identity with user preferences in single object
4. **Type Safety**: Constant type mismatches between expected vs actual store structure

### Current Problematic Structure

```typescript
// ❌ Current: Everything mixed together
userSettings: {
  name: 'Alice Smith',     // Identity
  username?: 'alice',      // Identity (missing in type def)
  theme?: 'dark',         // Preference (missing in type def)
  currency?: 'USD'        // Preference (missing in type def)
}
```

## Solution: Separate User Identity from User Preferences

### Proposed New Structure

```typescript
// ✅ Proposed: Clear separation with simplified user model
user: {
  id: string;           // Internal unique ID (replaces internalUserId)
  displayName: string;  // Human-readable name for all UI purposes
} | null;

settings: {
  theme: 'light' | 'dark';
  currency: string;
  dateFormat: string;
  notifications?: boolean;
}
```

## Why Remove Username?

### Analysis of Current Username Usage

1. **Group Creation Gate**: Artificially requires username before groups - unnecessary complexity
2. **Participant Display**: Could use displayName instead
3. **Social Features**: App has no user-to-user invites, friend requests, or user search
4. **Validation Overhead**: Complex rules (2-30 chars, alphanumeric) for minimal benefit

### Simplified Approach: ID + DisplayName Only

```typescript
user: {
  id: string; // System ID: "user_abc123" (immutable, for data relationships)
  displayName: string; // Display: "Alice Smith" (changeable, for all UI)
}
```

**Benefits of removing username:**

- **Simpler UX**: Users just enter their name, no "username" concept
- **Less Validation**: No complex username rules to enforce
- **Clearer Purpose**: displayName is what actually gets shown everywhere
- **Reduced Complexity**: One less field to manage and validate

### Group Participants Without Username

```typescript
// ❌ Old: Username-based (unnecessary)
participants: ['alice', 'bob'];

// ✅ New: Rich participant objects
participants: [
  { id: 'user_123', displayName: 'Alice Smith' },
  { id: 'user_456', displayName: 'Bob Jones' },
];
```

## Implementation Plan

### Step 1: Update Type Definitions

```typescript
// New interfaces in types/index.ts
export interface User {
  id: string; // Replaces internalUserId
  displayName: string; // Human-readable name for all purposes
}

export interface Settings {
  theme: 'light' | 'dark';
  currency: string;
  dateFormat: string;
  notifications?: boolean;
}
```

### Step 2: Refactor UserStore

```typescript
// New userStore structure
export interface UserState {
  user: User | null;
  settings: Settings;

  // Actions
  updateUser: (user: Partial<User>) => void;
  updateSettings: (settings: Partial<Settings>) => void;
  createUser: (displayName: string) => string; // Returns ID, only needs name
}
```

### Step 3: Update ComposedExpenseStore

```typescript
// Expose clear separation in main store
export const useExpenseStore = create<ExpenseState>((set, get) => ({
  // State
  user: useUserStore.getState().user,
  settings: useUserStore.getState().settings,

  // Actions
  updateUser: (userData) => useUserStore.getState().updateUser(userData),
  updateSettings: (settingsData) =>
    useUserStore.getState().updateSettings(settingsData),
}));
```

### Step 4: Update ExpenseState Interface

```typescript
export interface ExpenseState {
  // Remove old fields
  // userSettings: UserSettings | null;  ❌
  // internalUserId: string | null;       ❌

  // Add new fields
  user: User | null;                      ✅
  settings: Settings;                     ✅

  // Update actions
  updateUser: (user: Partial<User>) => void;
  updateSettings: (settings: Partial<Settings>) => void;
}
```

### Step 5: Fix Integration Tests

```typescript
// Update test expectations
beforeEach(() => {
  useExpenseStore.setState({
    user: null,
    settings: {
      theme: 'light',
      currency: 'USD',
      dateFormat: 'MM/DD/YYYY',
    },
  });
});

// Update test calls - simplified without username
store.updateUser({ displayName: 'Test User' });
store.updateSettings({ theme: 'dark', currency: 'EUR' });
```

### Step 6: Update Group Creation Logic

```typescript
// Simplified group creation without username requirement
addGroup: (name) => {
  const user = useUserStore.getState().user;

  if (!user) {
    throw new Error('User must be set up before creating groups');
  }

  // Use user.id for internal relationships
  // Use user.displayName for display
  return createGroupWithUser(name, user);
};
```

## Migration Strategy

### Phase 1: Add New Types (Non-breaking)

- Add `User` and `Settings` interfaces
- Keep existing `UserSettings` interface
- Add new methods alongside old ones

### Phase 2: Update Store Implementation

- Refactor userStore internal structure
- Update composedExpenseStore to expose both APIs
- Maintain backward compatibility

### Phase 3: Update Tests and UI

- Fix integration tests to use new structure
- Update UI components to use new APIs
- Remove old API usage

### Phase 4: Cleanup

- Remove deprecated `UserSettings` interface
- Remove old store methods
- Clean up any remaining references

## Benefits After Refactor

### 1. Clear Separation of Concerns

```typescript
// ✅ Identity operations
store.updateUser({ displayName: 'Alice Cooper' });

// ✅ Preference operations
store.updateSettings({ theme: 'dark' });
```

### 2. Better Type Safety

```typescript
// ✅ Each property properly typed
user.username: string        // Always valid
settings.currency: string    // Always valid
```

### 3. Cleaner Test APIs

```typescript
// ✅ Test what you mean
expect(store.user.username).toBe('alice');
expect(store.settings.theme).toBe('dark');
```

### 4. Better UX Patterns

- Clear "Account" vs "Preferences" sections
- Username can be changed independently of preferences
- Settings persist even if user changes username

## Risk Mitigation

### 1. Data Migration

- Existing users: Map `userSettings.name` → `user.displayName`
- Generate username from displayName if needed
- Preserve all existing preferences

### 2. Backward Compatibility

- Keep old APIs during transition
- Gradual migration of UI components
- Comprehensive testing at each step

### 3. Type Safety

- Strict TypeScript throughout refactor
- Test coverage for all new APIs
- Integration tests verify end-to-end functionality

## Success Criteria

### Technical

- [ ] All integration tests pass
- [ ] Component logic tests unchanged
- [ ] No type errors in codebase
- [ ] Store APIs are intuitive and clear

### User Experience

- [ ] Group creation flow works seamlessly
- [ ] Settings changes persist correctly
- [ ] Username validation works as expected
- [ ] Clear separation between identity and preferences

### Code Quality

- [ ] Types accurately reflect implementation
- [ ] Store structure is logical and maintainable
- [ ] Test coverage remains comprehensive
- [ ] Documentation is up to date

---

## Implementation Timeline

**Estimated Effort**: 4-6 hours

1. **Step 1-2**: Type definitions and store refactor (2 hours)
2. **Step 3-4**: Interface updates and store composition (1 hour)
3. **Step 5**: Integration test fixes (1-2 hours)
4. **Step 6**: Testing and verification (1 hour)

**Next Steps**: Proceed with Step 1 after plan approval.
