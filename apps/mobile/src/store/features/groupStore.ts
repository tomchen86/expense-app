import { create } from 'zustand';
import { ExpenseGroup, Participant } from '../../types';

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export interface GroupState {
  groups: ExpenseGroup[];

  // Actions
  addGroup: (name: string, creatorParticipant?: Participant) => string;
  updateGroup: (group: ExpenseGroup) => void;
  deleteGroup: (id: string) => void;
  getGroupById: (id: string) => ExpenseGroup | undefined;

  // Participant management
  addParticipantToGroup: (
    groupId: string,
    participantId: string,
    participant: Participant,
  ) => void;
  removeParticipantFromGroup: (groupId: string, participantId: string) => void;
  updateParticipantInGroups: (
    participantId: string,
    updatedParticipant: Participant,
  ) => void;
  removeParticipantFromAllGroups: (participantId: string) => void;
}

export const useGroupStore = create<GroupState>((set, get) => ({
  groups: [],

  addGroup: (name, creatorParticipant) => {
    const newGroupId = generateId();
    const newGroup: ExpenseGroup = {
      id: newGroupId,
      name,
      participants: creatorParticipant ? [creatorParticipant] : [],
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      groups: [...state.groups, newGroup],
    }));

    return newGroupId;
  },

  updateGroup: (updatedGroup) =>
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === updatedGroup.id ? updatedGroup : group,
      ),
    })),

  deleteGroup: (id) =>
    set((state) => ({
      groups: state.groups.filter((group) => group.id !== id),
    })),

  getGroupById: (id) => get().groups.find((group) => group.id === id),

  addParticipantToGroup: (groupId, participantId, participant) =>
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === groupId &&
        !group.participants.some((p) => p.id === participantId)
          ? {
              ...group,
              participants: [...group.participants, participant],
            }
          : group,
      ),
    })),

  removeParticipantFromGroup: (groupId, participantId) =>
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              participants: group.participants.filter(
                (p) => p.id !== participantId,
              ),
            }
          : group,
      ),
    })),

  updateParticipantInGroups: (participantId, updatedParticipant) =>
    set((state) => ({
      groups: state.groups.map((group) => ({
        ...group,
        participants: group.participants.map((p) =>
          p.id === participantId ? updatedParticipant : p,
        ),
      })),
    })),

  removeParticipantFromAllGroups: (participantId) =>
    set((state) => ({
      groups: state.groups.map((group) => ({
        ...group,
        participants: group.participants.filter((p) => p.id !== participantId),
      })),
    })),
}));
