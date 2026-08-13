import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { ExpenseState } from '../types';

// Import individual stores
import { useCategoryStore } from './features/categoryStore';
import { useUserStore } from './features/userStore';
import { useParticipantStore } from './features/participantStore';
import { useExpenseStore as useExpenseFeatureStore } from './features/expenseStore';
import { useGroupStore } from './features/groupStore';

export const useExpenseStore = create(
  subscribeWithSelector<ExpenseState>((set, _get) => {
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
      personalSpaceId: useUserStore.getState().personalSpaceId,
      personalParticipantId: useUserStore.getState().personalParticipantId,
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
        personalSpaceId: state.personalSpaceId,
        personalParticipantId: state.personalParticipantId,
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
          const { personalParticipantId, personalSpaceId } =
            useUserStore.getState();
          useParticipantStore
            .getState()
            .syncUserAsParticipant(
              personalParticipantId,
              { name: user.displayName },
              { userId: user.id, spaceId: personalSpaceId },
            );
        }
      },

      updateSettings: (settingsData) => {
        useUserStore.getState().updateSettings(settingsData);
      },

      createUser: (displayName) => {
        const userId = useUserStore.getState().createUser(displayName);
        const { personalParticipantId, personalSpaceId } =
          useUserStore.getState();
        useParticipantStore
          .getState()
          .syncUserAsParticipant(
            personalParticipantId,
            { name: displayName },
            { userId, spaceId: personalSpaceId },
          );
        return userId;
      },

      // --- Legacy User Settings Actions (temporary) ---
      updateUserSettings: (settings) => {
        useUserStore.getState().updateUserSettings(settings);

        // Sync user as participant
        const { internalUserId, personalParticipantId, personalSpaceId } =
          useUserStore.getState();
        if (internalUserId) {
          useParticipantStore
            .getState()
            .syncUserAsParticipant(personalParticipantId, settings, {
              userId: internalUserId,
              spaceId: personalSpaceId,
            });
        }
      },

      // --- Expense Actions ---
      addExpense: (expense) => {
        return useExpenseFeatureStore.getState().addExpense(expense);
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

        const userId = user?.id || legacyUserId;
        const displayName = user?.displayName || legacySettings?.name;
        const groupId = useGroupStore.getState().addGroup(name);
        if (userId) {
          const creatorName = displayName || `User ${userId.substring(0, 4)}`;
          const participantId = useParticipantStore
            .getState()
            .addParticipant(creatorName, undefined, {
              userId,
              spaceId: groupId,
            });
          const participant = useParticipantStore
            .getState()
            .getParticipantById(participantId);
          if (participant) {
            useGroupStore
              .getState()
              .addParticipantToGroup(groupId, participantId, participant);
          }
        }
        return groupId;
      },

      updateGroup: (group) => {
        useGroupStore.getState().updateGroup(group);
      },

      deleteGroup: (id) => {
        useGroupStore.getState().deleteGroup(id);
      },

      getGroupById: (id) => {
        return useGroupStore.getState().getGroupById(id);
      },

      // --- Participant Actions ---
      addParticipant: (name, idOverride, identity) => {
        return useParticipantStore
          .getState()
          .addParticipant(name, idOverride, identity);
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
  const { personalParticipantId, personalSpaceId } = useUserStore.getState();
  if (personalParticipantId && personalSpaceId) {
    useExpenseFeatureStore
      .getState()
      .migrateOrphanedExpenses(personalParticipantId, personalSpaceId);
  }
};

const initializeAfterHydration = () => {
  if (
    useUserStore.persist.hasHydrated() &&
    useExpenseFeatureStore.persist.hasHydrated()
  ) {
    initializeStore();
  }
};

useUserStore.persist.onFinishHydration(initializeAfterHydration);
useExpenseFeatureStore.persist.onFinishHydration(initializeAfterHydration);
initializeAfterHydration();
