import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { User, Settings, UserSettings } from '../../types';
import { createUuid } from '../../utils/ids';

export interface UserState {
  // New structure
  user: User | null;
  settings: Settings;

  // Legacy support (temporary)
  userSettings: UserSettings | null;
  internalUserId: string | null;
  personalSpaceId: string;
  personalParticipantId: string;

  // New actions
  updateUser: (userData: Partial<User>) => void;
  updateSettings: (settingsData: Partial<Settings>) => void;
  createUser: (displayName: string) => string; // Returns user ID

  // Legacy actions (temporary)
  updateUserSettings: (settings: UserSettings) => void;
  getInternalUserId: () => string;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => {
      // Generate initial user ID
      const initialUserId = createUuid();
      const initialPersonalSpaceId = createUuid();
      const initialPersonalParticipantId = createUuid();

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
        personalSpaceId: initialPersonalSpaceId,
        personalParticipantId: initialPersonalParticipantId,

        // New actions
        updateUser: (userData) => {
          const currentUser = get().user;
          const updatedUser = currentUser
            ? { ...currentUser, ...userData }
            : {
                id: get().internalUserId || initialUserId,
                displayName: '',
                personalSpaceId: get().personalSpaceId,
                ...userData,
              };

          set({ user: updatedUser });
        },

        updateSettings: (settingsData) => {
          const currentSettings = get().settings;
          set({ settings: { ...currentSettings, ...settingsData } });
        },

        createUser: (displayName) => {
          const userId = get().internalUserId || initialUserId;
          const newUser: User = {
            id: userId,
            displayName,
            personalSpaceId: get().personalSpaceId,
          };
          set({ user: newUser, internalUserId: userId });
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
                  personalSpaceId: get().personalSpaceId,
                };
            set({ user: updatedUser });
          }
        },

        getInternalUserId: () => {
          const state = get();
          return state.user?.id || state.internalUserId || '';
        },
      };
    },
    {
      name: 'expense-mobile-user-v2',
      version: 3,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        user: state.user,
        settings: state.settings,
        userSettings: state.userSettings,
        internalUserId: state.internalUserId,
        personalSpaceId: state.personalSpaceId,
        personalParticipantId: state.personalParticipantId,
      }),
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<UserState>;
        return {
          ...state,
          personalParticipantId: state.personalParticipantId ?? createUuid(),
        } as UserState;
      },
    },
  ),
);
