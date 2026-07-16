# Mobile App Data Structure Analysis

_Created: September 25, 2025_
_Purpose: Extract exact data structures from mobile app for API compatibility_

## Core Mobile App Interfaces

### 1. User & Identity Types

```typescript
// Core User Identity (from mobile app)
interface User {
  id: string; // Internal unique ID
  displayName: string; // Human-readable name
}

// User Settings/Preferences
interface Settings {
  theme: 'light' | 'dark';
  currency: string; // e.g., 'USD'
  dateFormat: string; // e.g., 'MM/DD/YYYY'
  notifications?: boolean;
}

// Legacy structure (being phased out)
interface UserSettings {
  name: string;
}
```

### 2. Category Structure

```typescript
interface Category {
  id: string; // Unique identifier (UUID or name-based)
  name: string; // Category name
  color: string; // Hex color code (e.g., '#FF5722')
}

// Used as identifier in expenses
type ExpenseCategory = string; // Category name as string
```

### 3. Participant Structure

```typescript
interface Participant {
  id: string; // Unique participant identifier
  name: string; // Display name
}
```

### 4. Expense Group Structure

```typescript
interface ExpenseGroup {
  id: string; // Unique group identifier
  name: string; // Group name
  participants: Participant[]; // Array of participants in group
  createdAt: string; // ISO date string
}
```

### 5. Expense Structure (MOST IMPORTANT)

```typescript
interface Expense {
  id: string; // Unique expense identifier
  title: string; // Expense description/title
  amount: number; // Amount in dollars (NOT cents)
  date: string; // Date as ISO string
  caption?: string; // Optional additional description
  category: ExpenseCategory; // Category name (string)
  groupId?: string; // Optional group reference
  paidBy?: string; // Participant ID who paid
  splitBetween?: string[]; // Array of participant IDs for splitting
  participants?: Participant[]; // Participants involved in expense
}
```

## Mobile App Store Structure (Zustand)

```typescript
interface ExpenseState {
  // Data collections
  expenses: Expense[];
  groups: ExpenseGroup[];
  participants: Participant[];
  categories: Category[];

  // User data (new structure)
  user: User | null;
  settings: Settings;

  // Legacy user data (being phased out)
  userSettings: UserSettings | null;
  internalUserId: string | null;

  // Core operations the API must support
  addExpense: (expense: Omit<Expense, 'id'>) => void;
  updateExpense: (expense: Expense) => void;
  deleteExpense: (id: string) => void;
  getExpenseById: (id: string) => Expense | undefined;

  // User operations
  updateUser: (userData: Partial<User>) => void;
  updateSettings: (settingsData: Partial<Settings>) => void;
  createUser: (displayName: string) => string;

  // Group operations
  addGroup: (name: string) => string;
  updateGroup: (group: ExpenseGroup) => void;
  deleteGroup: (id: string) => void;

  // Participant operations
  addParticipant: (name: string, idOverride?: string) => string;
  updateParticipant: (participant: Participant) => void;
  deleteParticipant: (id: string) => void;

  // Category operations
  addCategory: (categoryData: Omit<Category, 'id'>) => Category;
  updateCategory: (category: Category) => void;
  deleteCategory: (categoryId: string) => void;
  getCategoryByName: (name: string) => Category | undefined;
}
```

## Critical API Compatibility Requirements

### 1. **Amount Storage Difference**

- **Mobile**: Stores amounts as `number` (dollars, e.g., 25.50)
- **Database**: Stores amounts as `BIGINT` (cents, e.g., 2550)
- **API Must**: Convert between dollars ↔ cents transparently

### 2. **ID Generation Patterns**

- **Mobile**: Uses string IDs (some UUID, some generated)
- **Database**: Uses UUID primary keys
- **API Must**: Preserve mobile ID patterns where possible

### 3. **Date Handling**

- **Mobile**: Uses ISO date strings
- **Database**: Uses TIMESTAMPTZ and DATE types
- **API Must**: Convert between formats seamlessly

### 4. **Category References**

- **Mobile**: References categories by name string
- **Database**: Uses UUID foreign keys
- **API Must**: Support both name-based and ID-based lookups

### 5. **Expense Splitting Logic**

- **Mobile**: Uses `splitBetween` array of participant IDs
- **Database**: Uses separate `expense_splits` table
- **API Must**: Convert between representations

## Mobile App Error Handling Patterns

```typescript
// Based on mobile app patterns, API should return:
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    field?: string; // For form validation
  };
}
```

## Default Categories (Mobile App)

```typescript
// Mobile app's default categories (from constants/expenses.ts analysis needed)
const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining', color: '#FF5722' },
  { name: 'Transportation', color: '#2196F3' },
  { name: 'Shopping', color: '#9C27B0' },
  { name: 'Entertainment', color: '#FF9800' },
  { name: 'Bills & Utilities', color: '#F44336' },
  { name: 'Healthcare', color: '#4CAF50' },
  { name: 'Travel', color: '#00BCD4' },
  { name: 'Other', color: '#607D8B' },
];
```

## API Endpoint Requirements (Based on Mobile Operations)

### Authentication

- `POST /auth/login` - Basic authentication
- `POST /auth/register` - User registration
- `GET /auth/me` - Get current user

### User Management

- `GET /users/profile` - Get user profile
- `PUT /users/profile` - Update user profile
- `GET /users/settings` - Get user settings
- `PUT /users/settings` - Update settings (including persistence mode)

### Categories

- `GET /categories` - List user's categories
- `POST /categories` - Create category
- `PUT /categories/:id` - Update category
- `DELETE /categories/:id` - Delete category

### Participants

- `GET /participants` - List participants
- `POST /participants` - Create participant
- `PUT /participants/:id` - Update participant
- `DELETE /participants/:id` - Delete participant

### Groups

- `GET /groups` - List groups
- `POST /groups` - Create group
- `PUT /groups/:id` - Update group
- `DELETE /groups/:id` - Delete group
- `POST /groups/:id/participants` - Add participant to group
- `DELETE /groups/:id/participants/:participantId` - Remove from group

### Expenses (CRITICAL)

- `GET /expenses` - List expenses with pagination/filtering
- `POST /expenses` - Create expense (with automatic split calculation)
- `GET /expenses/:id` - Get expense details
- `PUT /expenses/:id` - Update expense
- `DELETE /expenses/:id` - Delete expense

### Data Migration (New requirement)

- `POST /migrate/local-data` - Import local data to cloud
- `GET /migrate/status` - Check migration status

## Mobile-to-API Data Mapping

### Expense Creation Payload

```typescript
// Mobile sends:
{
  title: string,
  amount: number,        // In dollars
  date: string,          // ISO string
  category: string,      // Category name
  groupId?: string,
  paidBy?: string,       // Participant ID
  splitBetween?: string[] // Participant IDs
}

// API must transform to:
{
  description: string,   // Maps to title
  amount_cents: number,  // Convert dollars to cents
  expense_date: string,  // Convert to date format
  category_id: string,   // Look up by category name
  group_id?: string,
  paid_by_participant_id?: string,
  splits: ExpenseSplit[] // Calculate from splitBetween
}
```

## Next Steps for TDD Implementation

1. ✅ **Mobile Analysis Complete**
2. 🔧 **Clean up non-TDD implementations**
3. 🧪 **Set up mobile-compatible test infrastructure**
4. 🔴 **Start with authentication TDD cycle**
5. 📱 **Validate API responses match mobile expectations exactly**

---

_This analysis provides the exact data structures and requirements needed to build a mobile-compatible API using TDD methodology._
