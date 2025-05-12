import { create } from "zustand";
import {
  ExpenseState,
  Expense,
  ExpenseGroup,
  Participant,
  UserSettings,
} from "../types";

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export const useExpenseStore = create<ExpenseState>((set, get) => {
  // --- Initialization ---
  let initialInternalUserId = null; // In a real app, load from AsyncStorage
  if (!initialInternalUserId) {
    initialInternalUserId = `user_${generateId()}`; // Ensure it's unique
    // In a real app, save to AsyncStorage here
  }

  const initialExpenses: Expense[] = []; // Load from AsyncStorage if implementing persistence
  const initialGroups: ExpenseGroup[] = [];
  const initialParticipants: Participant[] = [];
  const initialUserSettings: UserSettings | null = null;

  // One-time migration for orphaned expenses & ensure main user participant
  const migratedExpenses = initialExpenses.map((exp) => {
    if (!exp.groupId && !exp.paidBy && initialInternalUserId) {
      return {
        ...exp,
        groupId: initialInternalUserId,
        paidBy: initialInternalUserId,
      };
    }
    return exp;
  });

  let migratedParticipants = [...initialParticipants];
  if (initialInternalUserId && initialUserSettings?.name) {
    const userParticipantExists = migratedParticipants.some(
      (p) => p.id === initialInternalUserId
    );
    if (!userParticipantExists) {
      migratedParticipants.push({
        id: initialInternalUserId,
        name: initialUserSettings.name,
      });
    } else {
      migratedParticipants = migratedParticipants.map((p) =>
        p.id === initialInternalUserId
          ? { ...p, name: initialUserSettings.name }
          : p
      );
    }
  }

  // --- Initial Store State ---
  const initialState = {
    expenses: migratedExpenses,
    groups: initialGroups,
    participants: migratedParticipants,
    userSettings: initialUserSettings,
    internalUserId: initialInternalUserId,
  };

  return {
    ...initialState,

    // --- Actions ---

    updateUserSettings: (settings) =>
      set((state) => {
        const { internalUserId, participants } = state;
        let newParticipants = [...participants];
        let userAsParticipant = newParticipants.find(
          (p) => p.id === internalUserId
        );

        if (internalUserId && settings.name) {
          if (userAsParticipant) {
            if (userAsParticipant.name !== settings.name) {
              newParticipants = newParticipants.map((p) =>
                p.id === internalUserId ? { ...p, name: settings.name } : p
              );
            }
          } else {
            newParticipants.push({ id: internalUserId, name: settings.name });
          }
          return {
            ...state,
            userSettings: settings,
            participants: newParticipants,
          };
        }
        return { ...state, userSettings: settings };
      }),

    addExpense: (expense) => {
      const newExpenseWithId = {
        ...expense,
        id: generateId(),
      };
      set((state) => ({
        ...state,
        expenses: [...state.expenses, newExpenseWithId].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        ),
      }));
    },

    updateExpense: (updatedExpense) =>
      set((state) => ({
        ...state,
        expenses: state.expenses
          .map((expense) =>
            expense.id === updatedExpense.id ? updatedExpense : expense
          )
          .sort(
            (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
          ),
      })),

    deleteExpense: (id) =>
      set((state) => ({
        ...state,
        expenses: state.expenses.filter((expense) => expense.id !== id),
      })),

    getExpenseById: (id) => get().expenses.find((expense) => expense.id === id),

    addGroup: (name) => {
      const newGroupId = generateId();
      const { internalUserId, userSettings, participants } = get();
      let groupCreatorParticipant: Participant | undefined = undefined;

      if (internalUserId && userSettings?.name) {
        groupCreatorParticipant = participants.find(
          (p) => p.id === internalUserId && p.name === userSettings.name
        );
        if (!groupCreatorParticipant) {
          console.warn(
            "[expenseStore.addGroup] User participant for internalUserId not found. Group created without auto-adding creator."
          );
        }
      } else if (internalUserId && !userSettings?.name) {
        groupCreatorParticipant = participants.find(
          (p) => p.id === internalUserId
        );
        if (!groupCreatorParticipant) {
          const placeholderName = `User ${internalUserId.substring(0, 4)}`;
          get().addParticipant(placeholderName, internalUserId);
          groupCreatorParticipant = {
            id: internalUserId,
            name: placeholderName,
          };
        }
      }

      const newGroup: ExpenseGroup = {
        id: newGroupId,
        name,
        participants: groupCreatorParticipant ? [groupCreatorParticipant] : [],
        createdAt: new Date().toISOString(),
      };

      set((state) => ({
        ...state,
        groups: [...state.groups, newGroup],
      }));
      return newGroupId;
    },

    updateGroup: (updatedGroup) =>
      set((state) => ({
        ...state,
        groups: state.groups.map((group) =>
          group.id === updatedGroup.id ? updatedGroup : group
        ),
      })),

    deleteGroup: (id) =>
      set((state) => ({
        ...state,
        groups: state.groups.filter((group) => group.id !== id),
        expenses: state.expenses.map((expense) =>
          expense.groupId === id ? { ...expense, groupId: undefined } : expense
        ),
      })),

    getGroupById: (id) => get().groups.find((group) => group.id === id),

    addParticipant: (name, idOverride?: string) => {
      const id = idOverride || generateId();
      set((state) => {
        const existingById = state.participants.find((p) => p.id === id);
        const existingByName = state.participants.find(
          (p) => p.name === name && p.id !== id
        );

        if (existingById && idOverride) {
          if (existingById.name !== name) {
            return {
              ...state,
              participants: state.participants.map((p) =>
                p.id === id ? { ...p, name } : p
              ),
            };
          }
          return state;
        }
        if (existingByName) {
          console.warn(
            `Participant with name "${name}" already exists with a different ID.`
          );
          return state;
        }
        if (!existingById && !existingByName) {
          return {
            ...state,
            participants: [...state.participants, { id, name }],
          };
        }
        return state;
      });
      return id;
    },

    updateParticipant: (updatedParticipant) =>
      set((state) => ({
        ...state,
        participants: state.participants.map((participant) =>
          participant.id === updatedParticipant.id
            ? updatedParticipant
            : participant
        ),
      })),

    deleteParticipant: (id) =>
      set((state) => ({
        ...state,
        participants: state.participants.filter(
          (participant) => participant.id !== id
        ),
        groups: state.groups.map((group) => ({
          ...group,
          participants: group.participants.filter((p) => p.id !== id),
        })),
        expenses: state.expenses.map((expense) => ({
          ...expense,
          paidBy: expense.paidBy === id ? undefined : expense.paidBy,
          splitBetween: expense.splitBetween?.filter((pid) => pid !== id),
        })),
      })),

    getParticipantById: (id) =>
      get().participants.find((participant) => participant.id === id),

    addParticipantToGroup: (groupId, participantId) =>
      set((state) => {
        const participantToAdd = state.participants.find(
          (p) => p.id === participantId
        );
        if (!participantToAdd) return state;

        return {
          ...state,
          groups: state.groups.map((group) =>
            group.id === groupId &&
            !group.participants.some((p) => p.id === participantId)
              ? {
                  ...group,
                  participants: [...group.participants, participantToAdd],
                }
              : group
          ),
        };
      }),

    removeParticipantFromGroup: (groupId, participantId) =>
      set((state) => ({
        ...state,
        groups: state.groups.map((group) =>
          group.id === groupId
            ? {
                ...group,
                participants: group.participants.filter(
                  (p) => p.id !== participantId
                ),
              }
            : group
        ),
      })),
  };
});
