import { create } from "zustand";
import { UserSettings } from "../../types";

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export interface UserState {
  userSettings: UserSettings | null;
  internalUserId: string | null;
  
  // Actions
  updateUserSettings: (settings: UserSettings) => void;
  getInternalUserId: () => string;
}

export const useUserStore = create<UserState>((set, get) => {
  // --- Initialization ---
  let initialInternalUserId = null; // In a real app, load from AsyncStorage
  if (!initialInternalUserId) {
    initialInternalUserId = `user_${generateId()}`; // Ensure it's unique
    // In a real app, save to AsyncStorage here
  }

  const initialUserSettings: UserSettings | null = null;

  return {
    userSettings: initialUserSettings,
    internalUserId: initialInternalUserId,

    updateUserSettings: (settings) => {
      set({ userSettings: settings });
    },

    getInternalUserId: () => {
      const state = get();
      return state.internalUserId || '';
    },
  };
});