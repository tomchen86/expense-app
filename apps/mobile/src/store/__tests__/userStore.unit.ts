import { useUserStore } from '../features/userStore';

const defaultSettings = {
  theme: 'light' as const,
  currency: 'USD',
  dateFormat: 'MM/DD/YYYY',
  notifications: true,
};

const resetUserStore = () => {
  const { internalUserId, personalSpaceId, personalParticipantId } =
    useUserStore.getState();

  useUserStore.setState({
    user: null,
    settings: { ...defaultSettings },
    userSettings: null,
    internalUserId,
    personalSpaceId,
    personalParticipantId,
  });
};

describe('UserStore', () => {
  beforeEach(() => {
    resetUserStore();
  });

  afterEach(() => {
    resetUserStore();
  });

  it('updates the user profile while preserving the internal identifier', () => {
    const { internalUserId } = useUserStore.getState();

    useUserStore.getState().updateUser({ displayName: 'Jamie' });

    const state = useUserStore.getState();
    expect(state.user).toMatchObject({
      id: internalUserId,
      displayName: 'Jamie',
    });
  });

  it('creates a new user and returns the generated identifier', () => {
    const id = useUserStore.getState().createUser('Morgan');

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(useUserStore.getState().user).toMatchObject({
      id,
      displayName: 'Morgan',
    });
  });

  it('merges settings updates without dropping existing defaults', () => {
    useUserStore.getState().updateSettings({ currency: 'EUR' });

    const { settings } = useUserStore.getState();
    expect(settings.currency).toBe('EUR');
    expect(settings.theme).toBe('light');
  });

  it('syncs legacy user settings into the new structure', () => {
    const { internalUserId } = useUserStore.getState();

    useUserStore.getState().updateUserSettings({ name: 'Riley' });

    const state = useUserStore.getState();
    expect(state.userSettings).toEqual({ name: 'Riley' });
    expect(state.user).toMatchObject({
      id: internalUserId,
      displayName: 'Riley',
    });
  });

  it('prefers the active user identifier when retrieving the internal ID', () => {
    const userId = useUserStore.getState().createUser('Taylor');

    expect(useUserStore.getState().getInternalUserId()).toBe(userId);
  });

  it('falls back to generated internal identifier when user not created', () => {
    resetUserStore();
    const fallbackId = useUserStore.getState().getInternalUserId();

    expect(fallbackId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps distinct UUID identities for the user, personal space, and participant', () => {
    const { internalUserId, personalSpaceId, personalParticipantId } =
      useUserStore.getState();
    const identities = [internalUserId, personalSpaceId, personalParticipantId];

    expect(new Set(identities).size).toBe(3);
    identities.forEach((id) =>
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    );
  });
});
