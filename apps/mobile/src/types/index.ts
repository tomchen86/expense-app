// Centralized type definitions for the application

// Import necessary types if they were defined elsewhere (e.g., constants)
// import { EXPENSE_CATEGORIES } from "../constants/expenses"; // Will be an array of Category objects

// Represents the name of the category, used as an identifier
export type ExpenseCategory = string;

export interface Category {
  id: string; // Unique identifier for the category (e.g., the name itself or a UUID)
  name: string;
  color: string; // Hex color code
}

export interface Participant {
  id: string;
  name: string;
}

export interface ExpenseGroup {
  id: string;
  name: string;
  participants: Participant[];
  createdAt: string;
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  date: string; // Store date as string for simplicity, can be Date object
  caption?: string; // Optional caption field
  category: ExpenseCategory;
  groupId?: string; // Reference to the group this expense belongs to
  paidBy?: string; // Participant ID who paid
  splitBetween?: string[]; // Participant IDs to split the expense between
  participants?: Participant[]; // Participants involved in this expense
}

export interface UserSettings {
  // Add export keyword
  name: string;
}

// Interface defining the shape of the Zustand store state and actions
export interface ExpenseState {
  expenses: Expense[];
  groups: ExpenseGroup[];
  participants: Participant[];
  categories: Category[]; // Add categories to the store state
  userSettings: UserSettings | null;
  internalUserId: string | null; // Add internalUserId
  addExpense: (expense: Omit<Expense, "id">) => void;
  updateExpense: (expense: Expense) => void;
  deleteExpense: (id: string) => void;
  getExpenseById: (id: string) => Expense | undefined;
  updateUserSettings: (settings: UserSettings) => void;

  // Group management
  addGroup: (name: string) => string; // Returns new group ID
  updateGroup: (group: ExpenseGroup) => void;
  deleteGroup: (id: string) => void;
  getGroupById: (id: string) => ExpenseGroup | undefined;

  // Participant management
  addParticipant: (name: string, idOverride?: string) => string; // Returns new participant ID, accepts optional ID
  updateParticipant: (participant: Participant) => void;
  deleteParticipant: (id: string) => void;
  getParticipantById: (id: string) => Participant | undefined;

  // Group participants
  addParticipantToGroup: (groupId: string, participantId: string) => void;
  removeParticipantFromGroup: (groupId: string, participantId: string) => void;

  // Category management
  addCategory: (categoryData: Omit<Category, "id">) => Category; // Returns the new category with an ID
  updateCategory: (category: Category) => void;
  deleteCategory: (categoryId: string) => void;
  getCategoryByName: (name: string) => Category | undefined;
}
