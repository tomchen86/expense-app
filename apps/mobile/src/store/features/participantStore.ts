import { create } from "zustand";
import { Participant, UserSettings } from "../../types";

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export interface ParticipantState {
  participants: Participant[];

  // Actions
  addParticipant: (name: string, idOverride?: string) => string;
  updateParticipant: (participant: Participant) => void;
  deleteParticipant: (id: string) => void;
  getParticipantById: (id: string) => Participant | undefined;
  syncUserAsParticipant: (
    internalUserId: string,
    userSettings: UserSettings | null,
  ) => void;
}

export const useParticipantStore = create<ParticipantState>((set, get) => ({
  participants: [],

  addParticipant: (name, idOverride?: string) => {
    const id = idOverride || generateId();
    set((state) => {
      const existingById = state.participants.find((p) => p.id === id);
      const existingByName = state.participants.find(
        (p) => p.name === name && p.id !== id,
      );

      if (existingById && idOverride) {
        if (existingById.name !== name) {
          return {
            ...state,
            participants: state.participants.map((p) =>
              p.id === id ? { ...p, name } : p,
            ),
          };
        }
        return state;
      }
      if (existingByName) {
        console.warn(
          `Participant with name "${name}" already exists with a different ID.`,
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
      participants: state.participants.map((participant) =>
        participant.id === updatedParticipant.id
          ? updatedParticipant
          : participant,
      ),
    })),

  deleteParticipant: (id) =>
    set((state) => ({
      participants: state.participants.filter(
        (participant) => participant.id !== id,
      ),
    })),

  getParticipantById: (id) =>
    get().participants.find((participant) => participant.id === id),

  syncUserAsParticipant: (
    internalUserId: string,
    userSettings: UserSettings | null,
  ) => {
    if (!internalUserId || !userSettings?.name) {
      return;
    }

    set((state) => {
      let newParticipants = [...state.participants];
      let userAsParticipant = newParticipants.find(
        (p) => p.id === internalUserId,
      );

      if (userAsParticipant) {
        if (userAsParticipant.name !== userSettings.name) {
          newParticipants = newParticipants.map((p) =>
            p.id === internalUserId ? { ...p, name: userSettings.name } : p,
          );
        }
      } else {
        newParticipants.push({ id: internalUserId, name: userSettings.name });
      }

      return { participants: newParticipants };
    });
  },
}));
