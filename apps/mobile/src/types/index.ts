// Centralized type definitions for the application

// Import necessary types if they were defined elsewhere (e.g., constants)
// import { EXPENSE_CATEGORIES } from "../constants/expenses"; // Will be an array of Category objects

// Represents the name of the category, used as an identifier
export type ExpenseCategory = string;

export interface Category {
  id: string; // Stable UUID; legacy name-based identifiers require migration before sync.
  name: string;
  color: string; // Hex color code
  isDefault?: boolean;
}

export interface Participant {
  id: string;
  name: string;
  active?: boolean;
  spaceId?: string;
  userId?: string;
}

export interface ExpenseGroup {
  id: string;
  name: string;
  participants: Participant[];
  createdAt: string;
}

export type ExpenseSpaceKind = 'personal' | 'shared';

export interface MoneyAllocation {
  participantId: string;
  amountMinor: number;
}

export type ExpenseSyncStatus =
  'local_only' | 'pending' | 'syncing' | 'synced' | 'conflict' | 'failed';

export interface ExpenseSyncMetadata {
  mutationId: string;
  serverVersion?: number;
  localRevision?: number;
  /** @deprecated Legacy mobile-local counter retained for hydration only. */
  version?: number;
  status: ExpenseSyncStatus;
  updatedAt: string;
  deletedAt?: string;
  lastError?: string;
}

export interface Expense {
  id: string;
  title: string;
  date: string;
  caption?: string;
  category: ExpenseCategory;
  categoryId?: string;

  // Canonical V2 fields. All newly-created expenses populate these fields.
  amountMinor?: number;
  currency?: string;
  spaceId?: string;
  spaceKind?: ExpenseSpaceKind;
  payments?: MoneyAllocation[];
  shares?: MoneyAllocation[];
  sync?: ExpenseSyncMetadata;

  // Legacy read compatibility. New writes must not populate these fields.
  amount?: number;
  groupId?: string;
  paidBy?: string;
  splitBetween?: string[];
  participants?: Participant[];
}

// User Identity (rarely changes)
export interface User {
  id: string; // Internal unique ID (replaces internalUserId)
  displayName: string; // Human-readable name for all purposes
  personalSpaceId?: string;
}

// User Preferences (frequently changes)
export interface Settings {
  theme: 'light' | 'dark';
  currency: string;
  dateFormat: string;
  notifications?: boolean;
}

// Legacy interface - will be removed after refactor
export interface UserSettings {
  name: string;
}

// Interface defining the shape of the Zustand store state and actions
export interface ExpenseState {
  expenses: Expense[];
  groups: ExpenseGroup[];
  participants: Participant[];
  categories: Category[];

  // New user structure
  user: User | null;
  settings: Settings;

  // Legacy structure (temporary - will be removed)
  userSettings: UserSettings | null;
  internalUserId: string | null;
  personalSpaceId: string;
  personalParticipantId: string;

  // Expense management
  addExpense: (expense: Omit<Expense, 'id' | 'sync'>) => string;
  updateExpense: (expense: Expense) => void;
  deleteExpense: (id: string) => void;
  getExpenseById: (id: string) => Expense | undefined;

  // New user management
  updateUser: (userData: Partial<User>) => void;
  updateSettings: (settingsData: Partial<Settings>) => void;
  createUser: (displayName: string) => string; // Returns user ID

  // Legacy user management (temporary)
  updateUserSettings: (settings: UserSettings) => void;

  // Group management
  addGroup: (name: string) => string; // Returns new group ID
  updateGroup: (group: ExpenseGroup) => void;
  deleteGroup: (id: string) => void;
  getGroupById: (id: string) => ExpenseGroup | undefined;

  // Participant management
  addParticipant: (
    name: string,
    idOverride?: string,
    identity?: Pick<Participant, 'spaceId' | 'userId'>,
  ) => string;
  updateParticipant: (participant: Participant) => void;
  deleteParticipant: (id: string) => void;
  getParticipantById: (id: string) => Participant | undefined;

  // Group participants
  addParticipantToGroup: (groupId: string, participantId: string) => void;
  removeParticipantFromGroup: (groupId: string, participantId: string) => void;

  // Category management
  addCategory: (categoryData: Omit<Category, 'id'>) => Category; // Returns the new category with an ID
  updateCategory: (category: Category) => void;
  deleteCategory: (categoryId: string) => void;
  getCategoryByName: (name: string) => Category | undefined;
}
