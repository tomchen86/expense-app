jest.mock("react-native", () => ({
  Alert: {
    alert: jest.fn(),
  },
  Platform: {
    OS: "ios",
    select: jest.fn((selection) => selection?.ios ?? selection?.default),
  },
}));

import React, { createRef, forwardRef, useImperativeHandle } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert } from "react-native";
import { DEFAULT_CATEGORIES } from "../../constants/expenses";
import { useExpenseForm } from "../useExpenseForm";
import { useExpenseStore as useComposedExpenseStore } from "../../store/expenseStore";
import { useCategoryStore } from "../../store/features/categoryStore";
import { useExpenseStore as useExpenseFeatureStore } from "../../store/features/expenseStore";
import { useGroupStore } from "../../store/features/groupStore";
import { useParticipantStore } from "../../store/features/participantStore";
import { useUserStore } from "../../store/features/userStore";
import type { Expense, ExpenseGroup, Participant } from "../../types";

const defaultSettings = {
  theme: "light" as const,
  currency: "USD",
  dateFormat: "MM/DD/YYYY",
  notifications: true,
};

const navigationModule = require("@react-navigation/native");
const originalUseNavigation = navigationModule.useNavigation;

const resetAllStores = () => {
  const { internalUserId } = useUserStore.getState();

  useUserStore.setState({
    user: null,
    settings: { ...defaultSettings },
    userSettings: null,
    internalUserId,
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
  });
};

const createNavigationMock = () => ({
  navigate: jest.fn(),
  dispatch: jest.fn(),
  reset: jest.fn(),
  goBack: jest.fn(),
  isFocused: jest.fn(() => true),
  canGoBack: jest.fn(() => true),
  getId: jest.fn(),
  getParent: jest.fn(),
  getState: jest.fn(() => ({ routes: [], index: 0 })),
});

const HookHarness = forwardRef(
  ({ editingExpense }: { editingExpense?: Expense | null }, ref) => {
    const hookValue = useExpenseForm({ editingExpense });
    useImperativeHandle(ref, () => hookValue, [hookValue]);
    return null;
  },
);
HookHarness.displayName = "HookHarness";

describe("useExpenseForm", () => {
  beforeEach(() => {
    resetAllStores();
    (Alert.alert as jest.Mock).mockClear();
  });

  afterEach(() => {
    navigationModule.useNavigation = originalUseNavigation;
  });

  it("creates a personal expense using the internal user identifier", () => {
    const navigationMock = createNavigationMock();
    navigationModule.useNavigation = jest.fn(() => navigationMock);

    const ref = createRef<ReturnType<typeof useExpenseForm>>();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<HookHarness ref={ref} editingExpense={null} />);
    });

    const { internalUserId } = useComposedExpenseStore.getState();

    act(() => {
      ref.current!.handleUpdateFormState("title", "Coffee run");
      ref.current!.handleUpdateFormState("amount", "8.75");
      ref.current!.handleUpdateFormState("caption", "Morning treat");
    });

    act(() => {
      ref.current!.handleSubmit();
    });

    const expenses = useComposedExpenseStore.getState().expenses;
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({
      title: "Coffee run",
      amount: 8.75,
      paidBy: internalUserId,
      groupId: internalUserId,
      caption: "Morning treat",
    });
    expect(navigationMock.goBack).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("validates group expenses require payer and participants", () => {
    const navigationMock = createNavigationMock();
    navigationModule.useNavigation = jest.fn(() => navigationMock);

    const group: ExpenseGroup = {
      id: "group-1",
      name: "Roommates",
      participants: [],
      createdAt: "2025-02-01T00:00:00.000Z",
    };
    act(() => {
      useGroupStore.setState({ groups: [group] });
      useComposedExpenseStore.setState({ groups: [group] });
    });

    const ref = createRef<ReturnType<typeof useExpenseForm>>();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<HookHarness ref={ref} editingExpense={null} />);
    });

    act(() => {
      ref.current!.handleUpdateFormState("title", "Shared dinner");
      ref.current!.handleUpdateFormState("amount", "42.00");
      ref.current!.handleUpdateFormState("selectedGroup", group);
    });

    act(() => {
      ref.current!.handleSubmit();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      "Validation Error",
      "When adding to a group, please select who paid and who to split with.",
    );
    expect(useComposedExpenseStore.getState().expenses).toHaveLength(0);
    expect(navigationMock.goBack).not.toHaveBeenCalled();
  });

  it("updates an existing expense when editing", () => {
    const navigationMock = createNavigationMock();
    navigationModule.useNavigation = jest.fn(() => navigationMock);

    const participant: Participant = { id: "p1", name: "Alex" };
    const group: ExpenseGroup = {
      id: "group-2",
      name: "Cycling Club",
      participants: [participant],
      createdAt: "2025-02-10T00:00:00.000Z",
    };
    const existingExpense: Expense = {
      id: "expense-1",
      title: "Snacks",
      amount: 15,
      date: "2025-03-01",
      category: DEFAULT_CATEGORIES[0].name,
      groupId: group.id,
      paidBy: participant.id,
      splitBetween: [participant.id],
      caption: "Team ride snacks",
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

    expect(ref.current!.formState.title).toBe("Snacks");

    act(() => {
      ref.current!.handleUpdateFormState("amount", "21.50");
      ref.current!.handleUpdateFormState("caption", "Updated snacks");
    });

    act(() => {
      ref.current!.handleSubmit();
    });

    const updated = useComposedExpenseStore
      .getState()
      .expenses.find((expense) => expense.id === "expense-1");

    expect(updated).toMatchObject({
      amount: 21.5,
      caption: "Updated snacks",
    });
    expect(navigationMock.goBack).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
