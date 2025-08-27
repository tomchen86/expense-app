import { create } from "zustand";
import { subscribeWithSelector } from 'zustand/middleware';
import { ExpenseState } from "../types";

// Import individual stores
import { useCategoryStore } from "./features/categoryStore";
import { useUserStore } from "./features/userStore";
import { useParticipantStore } from "./features/participantStore";
import { useExpenseStore as useExpenseFeatureStore } from "./features/expenseStore";
import { useGroupStore } from "./features/groupStore";

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export const useExpenseStore = create(
  subscribeWithSelector<ExpenseState>((set, get) => ({
    // --- Computed State (delegates to individual stores) ---
    get expenses() {
      return useExpenseFeatureStore.getState().expenses;
    },
    get groups() {
      return useGroupStore.getState().groups;
    },
    get participants() {
      return useParticipantStore.getState().participants;
    },
    get categories() {
      return useCategoryStore.getState().categories;
    },
    get userSettings() {
      return useUserStore.getState().userSettings;
    },
    get internalUserId() {
      return useUserStore.getState().internalUserId;
    },

    // --- User Settings Actions ---
    updateUserSettings: (settings) => {
      useUserStore.getState().updateUserSettings(settings);
      
      // Sync user as participant
      const internalUserId = useUserStore.getState().internalUserId;
      if (internalUserId) {
        useParticipantStore.getState().syncUserAsParticipant(internalUserId, settings);
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
      const internalUserId = useUserStore.getState().internalUserId;
      const userSettings = useUserStore.getState().userSettings;
      
      let groupCreatorParticipant = undefined;
      
      if (internalUserId && userSettings?.name) {
        const existingParticipant = useParticipantStore.getState().getParticipantById(internalUserId);
        
        if (existingParticipant && existingParticipant.name === userSettings.name) {
          groupCreatorParticipant = existingParticipant;
        } else if (!existingParticipant) {
          console.warn(
            "[expenseStore.addGroup] User participant for internalUserId not found. Group created without auto-adding creator."
          );
        }
      } else if (internalUserId && !userSettings?.name) {
        let existingParticipant = useParticipantStore.getState().getParticipantById(internalUserId);
        
        if (!existingParticipant) {
          const placeholderName = `User ${internalUserId.substring(0, 4)}`;
          useParticipantStore.getState().addParticipant(placeholderName, internalUserId);
          groupCreatorParticipant = {
            id: internalUserId,
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
      useGroupStore.getState().updateParticipantInGroups(participant.id, participant);
    },

    deleteParticipant: (id) => {
      useParticipantStore.getState().deleteParticipant(id);
      useGroupStore.getState().removeParticipantFromAllGroups(id);
      useExpenseFeatureStore.getState().updateExpensesForParticipantRemoval(id);
    },

    getParticipantById: (id) => {
      return useParticipantStore.getState().getParticipantById(id);
    },

    addParticipantToGroup: (groupId, participantId) => {
      const participant = useParticipantStore.getState().getParticipantById(participantId);
      if (participant) {
        useGroupStore.getState().addParticipantToGroup(groupId, participantId, participant);
      }
    },

    removeParticipantFromGroup: (groupId, participantId) => {
      useGroupStore.getState().removeParticipantFromGroup(groupId, participantId);
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
  }))
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