import { useGroupStore } from "../features/groupStore";
import type { Participant } from "../../types";

describe("GroupStore", () => {
  beforeEach(() => {
    useGroupStore.setState({ groups: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const sampleParticipant: Participant = { id: "p1", name: "Alice" };

  it("creates a group with the optional creator participant", () => {
    const { addGroup } = useGroupStore.getState();

    const id = addGroup("Weekend Trip", sampleParticipant);
    const created = useGroupStore
      .getState()
      .groups.find((group) => group.id === id);

    expect(created).toBeDefined();
    expect(created).toMatchObject({
      name: "Weekend Trip",
      participants: [sampleParticipant],
    });
    expect(new Date(created!.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("updates a group's fields", () => {
    const { addGroup, updateGroup } = useGroupStore.getState();
    const id = addGroup("Original", sampleParticipant);

    updateGroup({
      id,
      name: "Renamed",
      participants: [sampleParticipant],
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const group = useGroupStore
      .getState()
      .groups.find((existing) => existing.id === id);

    expect(group).toMatchObject({ name: "Renamed" });
  });

  it("deletes groups by identifier", () => {
    const { addGroup, deleteGroup } = useGroupStore.getState();
    const id = addGroup("Disposable", sampleParticipant);

    deleteGroup(id);

    expect(
      useGroupStore.getState().groups.find((group) => group.id === id),
    ).toBeUndefined();
  });

  it("retrieves groups by identifier", () => {
    const { addGroup, getGroupById } = useGroupStore.getState();
    const id = addGroup("Lookup", sampleParticipant);

    const group = getGroupById(id);
    expect(group).toBeDefined();
    expect(group?.name).toBe("Lookup");
  });

  it("adds participants to a group without duplication", () => {
    const { addGroup, addParticipantToGroup } = useGroupStore.getState();
    const id = addGroup("Shared Expenses", sampleParticipant);

    const participant: Participant = { id: "p2", name: "Blake" };

    addParticipantToGroup(id, participant.id, participant);
    addParticipantToGroup(id, participant.id, participant);

    const group = useGroupStore
      .getState()
      .groups.find((existing) => existing.id === id);

    expect(group?.participants).toEqual([
      sampleParticipant,
      participant,
    ]);
  });

  it("removes and updates participants across group utilities", () => {
    const {
      addGroup,
      addParticipantToGroup,
      removeParticipantFromGroup,
      updateParticipantInGroups,
      removeParticipantFromAllGroups,
    } = useGroupStore.getState();
    const id = addGroup("Club", sampleParticipant);
    const participant: Participant = { id: "p2", name: "Blake" };

    addParticipantToGroup(id, participant.id, participant);
    updateParticipantInGroups(participant.id, { id: "p2", name: "Blake Updated" });

    let group = useGroupStore
      .getState()
      .groups.find((existing) => existing.id === id);
    expect(group?.participants).toContainEqual({ id: "p2", name: "Blake Updated" });

    removeParticipantFromGroup(id, participant.id);
    group = useGroupStore
      .getState()
      .groups.find((existing) => existing.id === id);
    expect(group?.participants).toEqual([sampleParticipant]);

    addParticipantToGroup(id, participant.id, participant);
    removeParticipantFromAllGroups(participant.id);
    group = useGroupStore
      .getState()
      .groups.find((existing) => existing.id === id);
    expect(group?.participants).toEqual([sampleParticipant]);
  });
});
