import { create } from 'zustand';
import { subscribeWithSelector } from "zustand/middleware";
import { ExpenseState } from '../types';

// Import individual stores
import { useCategoryStore } from './features/categoryStore';
import { useUserStore } from './features/userStore';
import { useParticipantStore } from './features/participantStore';
import { useExpenseStore as useExpenseFeatureStore } from './features/expenseStore';
import { useGroupStore } from './features/groupStore';

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export const useExpenseStore = create(
  subscribeWithSelector<ExpenseState>((set, get) => {
    // Subscribe to individual stores and sync their state
    const initialState = {
      expenses: useExpenseFeatureStore.getState().expenses,
      groups: useGroupStore.getState().groups,
      participants: useParticipantStore.getState().participants,
      categories: useCategoryStore.getState().categories,

      // New structure
      user: useUserStore.getState().user,
      settings: useUserStore.getState().settings,

      // Legacy structure (temporary)
      userSettings: useUserStore.getState().userSettings,
      internalUserId: useUserStore.getState().internalUserId,
    };

    // Set up subscriptions to sync changes from individual stores
    useExpenseFeatureStore.subscribe((state) =>
      set({ expenses: state.expenses }),
    );
    useGroupStore.subscribe((state) => set({ groups: state.groups }));
    useParticipantStore.subscribe((state) =>
      set({ participants: state.participants }),
    );
    useCategoryStore.subscribe((state) =>
      set({ categories: state.categories }),
    );
    useUserStore.subscribe((state) =>
      set({
        // New structure
        user: state.user,
        settings: state.settings,

        // Legacy structure (temporary)
        userSettings: state.userSettings,
        internalUserId: state.internalUserId,
      }),
    );

    return {
      // --- State from individual stores ---
      ...initialState,

      // --- New User Actions ---
      updateUser: (userData) => {
        useUserStore.getState().updateUser(userData);

        // Sync user as participant
        const user = useUserStore.getState().user;
        if (user) {
          useParticipantStore
            .getState()
            .syncUserAsParticipant(user.id, { name: user.displayName });
        }
      },

      updateSettings: (settingsData) => {
        useUserStore.getState().updateSettings(settingsData);
      },

      createUser: (displayName) => {
        return useUserStore.getState().createUser(displayName);
      },

      // --- Legacy User Settings Actions (temporary) ---
      updateUserSettings: (settings) => {
        useUserStore.getState().updateUserSettings(settings);

        // Sync user as participant
        const internalUserId = useUserStore.getState().internalUserId;
        if (internalUserId) {
          useParticipantStore
            .getState()
            .syncUserAsParticipant(internalUserId, settings);
        }
      },

      // --- Expense Actions ---
      addExpense: (expense) => {
        useExpenseFeatureStore.getState().addExpense(expense);
      },

      updateExpense: (expense) => {
        useExpenseFeatureStore.getState().updateExpense(expense);
      },

      deleteExpense: (id) => {
        useExpenseFeatureStore.getState().deleteExpense(id);
      },

      getExpenseById: (id) => {
        return useExpenseFeatureStore.getState().getExpenseById(id);
      },

      // --- Group Actions ---
      addGroup: (name) => {
        // Use new user structure with fallback to legacy
        const user = useUserStore.getState().user;
        const legacyUserId = useUserStore.getState().internalUserId;
        const legacySettings = useUserStore.getState().userSettings;

        let groupCreatorParticipant;
        let userId = user?.id || legacyUserId;
        let displayName = user?.displayName || legacySettings?.name;

        if (userId) {
          const existingParticipant = useParticipantStore
            .getState()
            .getParticipantById(userId);

          if (
            existingParticipant &&
            displayName &&
            existingParticipant.name === displayName
          ) {
            groupCreatorParticipant = existingParticipant;
          } else if (!existingParticipant && displayName) {
            // Create participant for the user
            useParticipantStore.getState().addParticipant(displayName, userId);
            groupCreatorParticipant = {
              id: userId,
              name: displayName,
            };
          } else if (!existingParticipant && !displayName) {
            // Create placeholder participant
            const placeholderName = `User ${userId.substring(0, 4)}`;
            useParticipantStore
              .getState()
              .addParticipant(placeholderName, userId);
            groupCreatorParticipant = {
              id: userId,
              name: placeholderName,
            };
          } else {
            groupCreatorParticipant = existingParticipant;
          }
        }

        return useGroupStore.getState().addGroup(name, groupCreatorParticipant);
      },

      updateGroup: (group) => {
        useGroupStore.getState().updateGroup(group);
      },

      deleteGroup: (id) => {
        useGroupStore.getState().deleteGroup(id);
        useExpenseFeatureStore.getState().removeExpensesForGroup(id);
      },

      getGroupById: (id) => {
        return useGroupStore.getState().getGroupById(id);
      },

      // --- Participant Actions ---
      addParticipant: (name, idOverride?: string) => {
        return useParticipantStore.getState().addParticipant(name, idOverride);
      },

      updateParticipant: (participant) => {
        useParticipantStore.getState().updateParticipant(participant);
        useGroupStore
          .getState()
          .updateParticipantInGroups(participant.id, participant);
      },

      deleteParticipant: (id) => {
        useParticipantStore.getState().deleteParticipant(id);
        useGroupStore.getState().removeParticipantFromAllGroups(id);
        useExpenseFeatureStore
          .getState()
          .updateExpensesForParticipantRemoval(id);
      },

      getParticipantById: (id) => {
        return useParticipantStore.getState().getParticipantById(id);
      },

      addParticipantToGroup: (groupId, participantId) => {
        const participant = useParticipantStore
          .getState()
          .getParticipantById(participantId);
        if (participant) {
          useGroupStore
            .getState()
            .addParticipantToGroup(groupId, participantId, participant);
        }
      },

      removeParticipantFromGroup: (groupId, participantId) => {
        useGroupStore
          .getState()
          .removeParticipantFromGroup(groupId, participantId);
      },

      // --- Category Actions ---
      addCategory: (categoryData) => {
        return useCategoryStore.getState().addCategory(categoryData);
      },

      updateCategory: (category) => {
        useCategoryStore.getState().updateCategory(category);
      },

      deleteCategory: (categoryId) => {
        useCategoryStore.getState().deleteCategory(categoryId);
      },

      getCategoryByName: (name) => {
        return useCategoryStore.getState().getCategoryByName(name);
      },
    };
  }),
);

// Initialize migration for orphaned expenses on store creation
const initializeStore = () => {
  const internalUserId = useUserStore.getState().internalUserId;
  if (internalUserId) {
    useExpenseFeatureStore.getState().migrateOrphanedExpenses(internalUserId);
  }
};

// Run initialization
initializeStore();
