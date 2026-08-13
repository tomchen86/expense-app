jest.mock('react-native', () => ({
  Alert: {
    alert: jest.fn(),
  },
  Platform: {
    OS: 'ios',
    select: jest.fn((selection) => selection?.ios ?? selection?.default),
  },
}));

import React, { createRef, forwardRef, useImperativeHandle } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import { DEFAULT_CATEGORIES } from '../../constants/expenses';
import { useExpenseForm } from '../useExpenseForm';
import { useExpenseStore as useComposedExpenseStore } from '../../store/expenseStore';
import { useCategoryStore } from '../../store/features/categoryStore';
import { useExpenseStore as useExpenseFeatureStore } from '../../store/features/expenseStore';
import { useGroupStore } from '../../store/features/groupStore';
import { useParticipantStore } from '../../store/features/participantStore';
import { useUserStore } from '../../store/features/userStore';
import type { Expense, ExpenseGroup, Participant } from '../../types';

const defaultSettings = {
  theme: 'light' as const,
  currency: 'USD',
  dateFormat: 'MM/DD/YYYY',
  notifications: true,
};

// Expo router is already mocked in jest.setup.unit.ts
import { router } from 'expo-router';

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

// Router mocking is handled in jest.setup.unit.ts

interface HookHarnessProps {
  editingExpense?: Expense | null;
  initialSpaceId?: string;
}

const HookHarness = forwardRef(
  ({ editingExpense, initialSpaceId }: HookHarnessProps, ref) => {
    const hookValue = useExpenseForm({ editingExpense, initialSpaceId });
    useImperativeHandle(ref, () => hookValue, [hookValue]);
    return null;
  },
);
HookHarness.displayName = 'HookHarness';

describe('useExpenseForm', () => {
  beforeEach(() => {
    resetAllStores();
    (Alert.alert as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
  it('creates a canonical personal expense in the explicit personal space', async () => {
    const ref = createRef<ReturnType<typeof useExpenseForm>>();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <HookHarness ref={ref} editingExpense={null} />,
      );
    });

    const { personalParticipantId, personalSpaceId } =
      useComposedExpenseStore.getState();

    act(() => {
      ref.current!.handleUpdateFormState('title', 'Coffee run');
      ref.current!.handleUpdateFormState('amount', '8.75');
      ref.current!.handleUpdateFormState('caption', 'Morning treat');
    });

    await act(async () => {
      await ref.current!.handleSubmit();
    });

    const expenses = useComposedExpenseStore.getState().expenses;
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({
      title: 'Coffee run',
      amountMinor: 875,
      currency: 'USD',
      spaceId: personalSpaceId,
      spaceKind: 'personal',
      payments: [{ participantId: personalParticipantId, amountMinor: 875 }],
      shares: [{ participantId: personalParticipantId, amountMinor: 875 }],
      caption: 'Morning treat',
    });
    expect(expenses[0]).not.toHaveProperty('amount');
    expect(expenses[0]).not.toHaveProperty('groupId');
    expect(expenses[0]).not.toHaveProperty('paidBy');
    expect(expenses[0]).not.toHaveProperty('splitBetween');
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
  });
  it('stores the selected stable category identifier when available', async () => {
    const category = {
      id: 'f7686a96-d2d3-49bb-968f-e80e9f436763',
      name: 'Local custom',
      color: '#123456',
    };
    act(() => {
      useCategoryStore.setState({ categories: [category] });
      useComposedExpenseStore.setState({ categories: [category] });
    });

    const ref = createRef<ReturnType<typeof useExpenseForm>>();
    act(() => {
      TestRenderer.create(<HookHarness ref={ref} editingExpense={null} />);
    });
    act(() => {
      ref.current!.handleUpdateFormState('title', 'Custom category expense');
      ref.current!.handleUpdateFormState('amount', '12.00');
    });
    await act(async () => {
      await ref.current!.handleSubmit();
    });

    expect(useExpenseFeatureStore.getState().expenses[0]).toMatchObject({
      category: category.name,
      categoryId: category.id,
    });
  });
  it('validates group expenses require payer and participants', async () => {
    const group: ExpenseGroup = {
      id: 'group-1',
      name: 'Roommates',
      participants: [],
      createdAt: '2025-02-01T00:00:00.000Z',
    };
    act(() => {
      useGroupStore.setState({ groups: [group] });
      useComposedExpenseStore.setState({ groups: [group] });
    });

    const ref = createRef<ReturnType<typeof useExpenseForm>>();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <HookHarness ref={ref} editingExpense={null} />,
      );
    });

    act(() => {
      ref.current!.handleUpdateFormState('title', 'Shared dinner');
      ref.current!.handleUpdateFormState('amount', '42.00');
      ref.current!.handleUpdateFormState('selectedGroup', group);
    });

    await act(async () => {
      await ref.current!.handleSubmit();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Validation Error',
      'When adding to a group, please select who paid and who to split with.',
    );
    expect(useComposedExpenseStore.getState().expenses).toHaveLength(0);
    expect(router.back).not.toHaveBeenCalled();
  });
  it('preselects the shared space supplied by the group-detail route', () => {
    const participant: Participant = { id: 'p1', name: 'Alex' };
    const group: ExpenseGroup = {
      id: 'space-route',
      name: 'Route Group',
      participants: [participant],
      createdAt: '2025-02-01T00:00:00.000Z',
    };
    act(() => {
      useGroupStore.setState({ groups: [group] });
      useComposedExpenseStore.setState({ groups: [group] });
    });

    const ref = createRef<ReturnType<typeof useExpenseForm>>();
    act(() => {
      TestRenderer.create(
        <HookHarness
          ref={ref}
          editingExpense={null}
          initialSpaceId={group.id}
        />,
      );
    });

    expect(ref.current!.formState.selectedGroup?.id).toBe(group.id);
  });
  it('updates an existing expense when editing', async () => {
    const participant: Participant = { id: 'p1', name: 'Alex' };
    const group: ExpenseGroup = {
      id: 'group-2',
      name: 'Cycling Club',
      participants: [participant],
      createdAt: '2025-02-10T00:00:00.000Z',
    };
    const existingExpense: Expense = {
      id: 'expense-1',
      title: 'Snacks',
      amount: 15,
      date: '2025-03-01',
      category: DEFAULT_CATEGORIES[0].name,
      groupId: group.id,
      paidBy: participant.id,
      splitBetween: [participant.id],
      caption: 'Team ride snacks',
    };

    act(() => {
      useParticipantStore.setState({ participants: [participant] });
      useGroupStore.setState({ groups: [group] });
      useExpenseFeatureStore.setState({ expenses: [existingExpense] });
      useComposedExpenseStore.setState({
        participants: [participant],
        groups: [group],
        expenses: [existingExpense],
      });
    });

    const ref = createRef<ReturnType<typeof useExpenseForm>>();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <HookHarness ref={ref} editingExpense={existingExpense} />,
      );
    });

    expect(ref.current!.formState.title).toBe('Snacks');

    act(() => {
      ref.current!.handleUpdateFormState('amount', '21.50');
      ref.current!.handleUpdateFormState('caption', 'Updated snacks');
    });

    await act(async () => {
      await ref.current!.handleSubmit();
    });

    const updated = useComposedExpenseStore
      .getState()
      .expenses.find((expense) => expense.id === 'expense-1');

    expect(updated).toMatchObject({
      amountMinor: 2150,
      currency: 'USD',
      spaceId: group.id,
      spaceKind: 'shared',
      caption: 'Updated snacks',
    });
    expect(updated).not.toHaveProperty('amount');
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
