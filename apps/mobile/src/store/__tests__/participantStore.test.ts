import { useParticipantStore } from '../features/participantStore';

describe('ParticipantStore', () => {
  beforeEach(() => {
    useParticipantStore.setState({ participants: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('adds a participant and returns the generated identifier', () => {
    const { addParticipant } = useParticipantStore.getState();

    const id = addParticipant('Alex');

    expect(id).toBeTruthy();
    expect(useParticipantStore.getState().participants).toContainEqual({
      id,
      name: 'Alex',
    });
  });

  it('updates the display name when adding with an existing override identifier', () => {
    const { addParticipant } = useParticipantStore.getState();

    addParticipant('Original', 'participant-1');
    addParticipant('Updated', 'participant-1');

    expect(useParticipantStore.getState().participants).toContainEqual({
      id: 'participant-1',
      name: 'Updated',
    });
  });

  it('prevents duplicate names and logs a warning', () => {
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const { addParticipant } = useParticipantStore.getState();

    addParticipant('Taylor');
    addParticipant('Taylor');

    expect(useParticipantStore.getState().participants).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Participant with name "Taylor" already exists'),
    );
  });

  it('syncs the signed-in user as a participant and updates their name', () => {
    const { syncUserAsParticipant } = useParticipantStore.getState();

    syncUserAsParticipant('user-1', { name: 'Initial' });
    expect(useParticipantStore.getState().participants).toContainEqual({
      id: 'user-1',
      name: 'Initial',
    });

    syncUserAsParticipant('user-1', { name: 'Updated' });
    expect(useParticipantStore.getState().participants).toContainEqual({
      id: 'user-1',
      name: 'Updated',
    });
  });

  it('deletes a participant by identifier', () => {
    const { addParticipant, deleteParticipant } =
      useParticipantStore.getState();

    const id = addParticipant('Casey');
    deleteParticipant(id);

    expect(useParticipantStore.getState().participants).not.toContainEqual({
      id,
      name: 'Casey',
    });
  });

  it('retrieves participants and syncs when details missing', () => {
    const store = useParticipantStore.getState();
    const identifier = store.addParticipant('Jordan');
    expect(store.getParticipantById(identifier)).toEqual({
      id: identifier,
      name: 'Jordan',
    });

    store.syncUserAsParticipant('user-sync', null);
    expect(store.getParticipantById('user-sync')).toBeUndefined();
  });
});
