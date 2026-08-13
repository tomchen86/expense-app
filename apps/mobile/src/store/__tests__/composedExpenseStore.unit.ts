import { DEFAULT_CATEGORIES } from '../../constants/expenses';
import type { Expense, ExpenseGroup, Participant } from '../../types';
import { useExpenseStore as useComposedExpenseStore } from '../composedExpenseStore';
import { useCategoryStore } from '../features/categoryStore';
import { useExpenseStore as useExpenseFeatureStore } from '../features/expenseStore';
import { useGroupStore } from '../features/groupStore';
import { useParticipantStore } from '../features/participantStore';
import { useUserStore } from '../features/userStore';

const defaultSettings = {
  theme: 'light' as const,
  currency: 'USD',
  dateFormat: 'MM/DD/YYYY',
  notifications: true,
};

const resetAllStores = () => {
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
  useParticipantStore.setState({ participants: [] });
  useGroupStore.setState({ groups: [] });
  useCategoryStore.setState({
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
  });
  useExpenseFeatureStore.setState({ expenses: [] });

  useComposedExpenseStore.setState({
    expenses: [],
    groups: [],
    participants: [],
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
    user: null,
    settings: { ...defaultSettings },
    userSettings: null,
    internalUserId,
    personalSpaceId,
    personalParticipantId,
  });
};

describe('ComposedExpenseStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('synchronizes the user profile to the participant store', () => {
    const { updateUser } = useComposedExpenseStore.getState();

    updateUser({ displayName: 'Jamie' });

    const { user, participants, personalParticipantId, personalSpaceId } =
      useComposedExpenseStore.getState();
    const syncedParticipant = useParticipantStore
      .getState()
      .getParticipantById(personalParticipantId);

    expect(user?.displayName).toBe('Jamie');
    expect(syncedParticipant).toEqual({
      id: personalParticipantId,
      name: 'Jamie',
      userId: user!.id,
      spaceId: personalSpaceId,
    });
    expect(participants).toContainEqual(syncedParticipant);
  });

  it('creates groups seeded with the current user as a participant', () => {
    const { createUser, addGroup } = useComposedExpenseStore.getState();

    const userId = createUser('Morgan');
    const groupId = addGroup('Finance Squad');

    const group = useGroupStore.getState().getGroupById(groupId);
    expect(group).toBeDefined();
    const creator = group?.participants[0];
    expect(creator).toMatchObject({
      name: 'Morgan',
      userId,
      spaceId: groupId,
    });
    expect(creator?.id).not.toBe(userId);
    expect(creator?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      useParticipantStore.getState().getParticipantById(creator!.id),
    ).toEqual(creator);
  });

  it('manages categories across composed and feature stores', () => {
    const store = useComposedExpenseStore.getState();

    const created = store.addCategory({ name: 'Fitness', color: '#111111' });
    expect(created).toMatchObject({ name: 'Fitness', color: '#111111' });

    const fetched = store.getCategoryByName('Fitness');
    expect(fetched).toEqual(created);

    store.updateCategory({ ...created, color: '#00FF00' });
    expect(
      useCategoryStore.getState().getCategoryByName('Fitness')?.color,
    ).toBe('#00FF00');

    store.deleteCategory(created.id);
    expect(
      useCategoryStore.getState().getCategoryByName('Fitness'),
    ).toBeUndefined();
  });

  it('removes a group while retaining linked expense history', () => {
    const expense: Expense = {
      id: 'expense-1',
      title: 'Hotel',
      amount: 200,
      date: '2025-03-01',
      category: 'Travel',
      groupId: 'group-1',
    };
    const group: ExpenseGroup = {
      id: 'group-1',
      name: 'Trip Crew',
      participants: [],
      createdAt: '2025-02-01T00:00:00.000Z',
    };

    useGroupStore.setState({ groups: [group] });
    useExpenseFeatureStore.setState({ expenses: [expense] });
    useComposedExpenseStore.setState({
      groups: [group],
      expenses: [expense],
    });

    useComposedExpenseStore.getState().deleteGroup('group-1');

    expect(useGroupStore.getState().groups).toHaveLength(0);
    const updatedExpense = useExpenseFeatureStore
      .getState()
      .expenses.find((item) => item.id === 'expense-1');
    expect(updatedExpense?.groupId).toBe('group-1');

    const composedExpense = useComposedExpenseStore
      .getState()
      .expenses.find((item) => item.id === 'expense-1');
    expect(composedExpense?.groupId).toBe('group-1');
  });

  it('deactivates a participant while retaining expense allocations', () => {
    const group: ExpenseGroup = {
      id: 'group-2',
      name: 'Roommates',
      participants: [
        { id: 'p1', name: 'Casey' },
        { id: 'p2', name: 'Drew' },
      ],
      createdAt: '2025-02-15T00:00:00.000Z',
    };
    const expense: Expense = {
      id: 'expense-2',
      title: 'Utilities',
      amount: 120,
      date: '2025-02-20',
      category: 'Bills & Utilities',
      groupId: 'group-2',
      paidBy: 'p1',
      splitBetween: ['p1', 'p2'],
    };

    useParticipantStore.setState({
      participants: [
        { id: 'p1', name: 'Casey' },
        { id: 'p2', name: 'Drew' },
      ],
    });
    useGroupStore.setState({ groups: [group] });
    useExpenseFeatureStore.setState({ expenses: [expense] });
    useComposedExpenseStore.setState({
      participants: [
        { id: 'p1', name: 'Casey' },
        { id: 'p2', name: 'Drew' },
      ],
      groups: [group],
      expenses: [expense],
    });

    useComposedExpenseStore.getState().deleteParticipant('p1');

    expect(useParticipantStore.getState().participants).toEqual([
      { id: 'p1', name: 'Casey', active: false },
      { id: 'p2', name: 'Drew' },
    ]);
    const updatedGroup = useGroupStore.getState().getGroupById('group-2');
    expect(updatedGroup?.participants).toEqual([{ id: 'p2', name: 'Drew' }]);
    const updatedExpense = useExpenseFeatureStore
      .getState()
      .expenses.find((item) => item.id === 'expense-2');
    expect(updatedExpense?.paidBy).toBe('p1');
    expect(updatedExpense?.splitBetween).toEqual(['p1', 'p2']);

    const composedParticipants =
      useComposedExpenseStore.getState().participants;
    expect(composedParticipants).toEqual([
      { id: 'p1', name: 'Casey', active: false },
      { id: 'p2', name: 'Drew' },
    ]);
  });

  it('adds and updates participants through composed actions', () => {
    const store = useComposedExpenseStore.getState();

    const participantId = store.addParticipant('Casey');
    expect(participantId).toBeTruthy();
    expect(store.getParticipantById(participantId)).toEqual({
      id: participantId,
      name: 'Casey',
    });

    store.updateParticipant({ id: participantId, name: 'Casey Updated' });
    expect(store.getParticipantById(participantId)?.name).toBe('Casey Updated');
  });

  it('updates expenses and retrieves them by identifier', () => {
    const baseExpense: Expense = {
      id: 'expense-3',
      title: 'Dinner',
      amount: 60,
      date: '2025-02-01',
      category: 'Food & Dining',
    };

    useExpenseFeatureStore.setState({ expenses: [baseExpense] });
    useComposedExpenseStore.setState({ expenses: [baseExpense] });

    const store = useComposedExpenseStore.getState();
    const fetched = store.getExpenseById('expense-3');
    expect(fetched).toMatchObject({ title: 'Dinner' });

    store.updateExpense({ ...baseExpense, amount: 75 });
    expect(store.getExpenseById('expense-3')?.amount).toBe(75);
  });

  it('handles user settings updates and creation flows', () => {
    const store = useComposedExpenseStore.getState();

    store.updateSettings({ currency: 'EUR' });
    expect(useUserStore.getState().settings.currency).toBe('EUR');

    const newUserId = store.createUser('Jordan');
    expect(newUserId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    store.updateUser({ displayName: 'Jordan Updated' });
    expect(useUserStore.getState().user?.displayName).toBe('Jordan Updated');
  });

  it('manages group participant membership helpers', () => {
    const participant: Participant = { id: 'p10', name: 'Jamie' };
    useParticipantStore.setState({ participants: [participant] });

    const groupId = useGroupStore.getState().addGroup('Helpers', participant);
    useComposedExpenseStore.setState({
      groups: useGroupStore.getState().groups,
      participants: [participant],
    });

    const store = useComposedExpenseStore.getState();
    const groupBefore = store.getGroupById(groupId);
    expect(groupBefore?.participants).toHaveLength(1);

    const otherParticipant: Participant = { id: 'p11', name: 'Taylor' };
    useParticipantStore
      .getState()
      .addParticipant(otherParticipant.name, otherParticipant.id);
    store.addParticipantToGroup(groupId, otherParticipant.id);

    expect(store.getGroupById(groupId)?.participants).toEqual([
      participant,
      otherParticipant,
    ]);

    store.removeParticipantFromGroup(groupId, otherParticipant.id);
    expect(store.getGroupById(groupId)?.participants).toEqual([participant]);
  });
});
