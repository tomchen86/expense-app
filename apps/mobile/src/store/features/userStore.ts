import { create } from "zustand";
import { User, Settings, UserSettings } from "../../types";

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export interface UserState {
  // New structure
  user: User | null;
  settings: Settings;

  // Legacy support (temporary)
  userSettings: UserSettings | null;
  internalUserId: string | null;

  // New actions
  updateUser: (userData: Partial<User>) => void;
  updateSettings: (settingsData: Partial<Settings>) => void;
  createUser: (displayName: string) => string; // Returns user ID

  // Legacy actions (temporary)
  updateUserSettings: (settings: UserSettings) => void;
  getInternalUserId: () => string;
}

export const useUserStore = create<UserState>((set, get) => {
  // Generate initial user ID
  const initialUserId = `user_${generateId()}`;

  // Default settings
  const defaultSettings: Settings = {
    theme: 'light',
    currency: 'USD',
    dateFormat: 'MM/DD/YYYY',
    notifications: true,
  };

  return {
    // New structure
    user: null,
    settings: defaultSettings,

    // Legacy structure (temporary)
    userSettings: null,
    internalUserId: initialUserId,

    // New actions
    updateUser: (userData) => {
      const currentUser = get().user;
      const updatedUser = currentUser
        ? { ...currentUser, ...userData }
        : { id: initialUserId, displayName: '', ...userData };

      set({ user: updatedUser });
    },

    updateSettings: (settingsData) => {
      const currentSettings = get().settings;
      set({ settings: { ...currentSettings, ...settingsData } });
    },

    createUser: (displayName) => {
      const userId = `user_${generateId()}`;
      const newUser: User = {
        id: userId,
        displayName,
      };
      set({ user: newUser });
      return userId;
    },

    // Legacy actions (temporary)
    updateUserSettings: (settings) => {
      set({ userSettings: settings });

      // Sync to new structure if possible
      if (settings.name) {
        const currentUser = get().user;
        const updatedUser = currentUser
          ? { ...currentUser, displayName: settings.name }
          : {
              id: get().internalUserId || initialUserId,
              displayName: settings.name,
            };
        set({ user: updatedUser });
      }
    },

    getInternalUserId: () => {
      const state = get();
      return state.user?.id || state.internalUserId || '';
    },
  };
});
