import React, { createRef, forwardRef, useImperativeHandle, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useExpenseModals } from "../useExpenseModals";
import type { ExpenseGroup, Participant } from "../../types";

jest.mock("@react-navigation/native", () => ({
  useNavigation: jest.fn(),
}));

type HookHandle = {
  hookValue: ReturnType<typeof useExpenseModals>;
  getFormState: () => {
    category: "Food & Dining";
    selectedGroup: ExpenseGroup | null;
    paidByParticipant: Participant | null;
    selectedParticipants: Participant[];
  };
};

const buildHarness = (
  initialParticipants: Participant[],
  initialGroup: ExpenseGroup | null = null,
) => {
  const participants = initialParticipants;
  const initialState = {
    category: "Food & Dining" as const,
    selectedGroup: initialGroup,
    paidByParticipant: null,
    selectedParticipants: [] as Participant[],
  };

  return forwardRef<HookHandle>((_, ref) => {
    const [formState, setFormState] = useState(initialState);
    const hookValue = useExpenseModals({
      formState,
      participants,
      handleUpdateFormState: (field, value) => {
        setFormState((prev) => ({ ...prev, [field]: value }));
      },
      setFormState,
    });

    useImperativeHandle(
      ref,
      () => ({ hookValue, getFormState: () => formState }),
      [hookValue, formState],
    );
    return null;
  });
};

describe("useExpenseModals", () => {
  const participants: Participant[] = [
    { id: "p1", name: "Alice" },
    { id: "p2", name: "Bob" },
  ];

  const group: ExpenseGroup = {
    id: "g1",
    name: "Trip",
    participants,
    createdAt: "2025-02-01",
  };

  it("sets and clears group selections and dependent fields", () => {
    const Harness = buildHarness(participants);
    const ref = createRef<HookHandle>();

    act(() => {
      TestRenderer.create(<Harness ref={ref} />);
    });

    act(() => {
      ref.current!.hookValue.setShowGroupModal(true);
      ref.current!.hookValue.handleGroupSelect(group);
    });

    expect(ref.current!.getFormState().selectedGroup).toEqual(group);
    act(() => {
      ref.current!.hookValue.handleGroupClear();
    });
    expect(ref.current!.getFormState().selectedGroup).toBeNull();
    expect(ref.current!.getFormState().selectedParticipants).toHaveLength(0);
  });

  it("toggles participants in split selections", () => {
    const Harness = buildHarness(participants, group);
    const ref = createRef<HookHandle>();

    act(() => {
      TestRenderer.create(<Harness ref={ref} />);
    });

    const participant = participants[0];

    act(() => {
      ref.current!.hookValue.handleParticipantSelect(participant);
    });
    expect(ref.current!.getFormState().selectedParticipants).toEqual([participant]);

    act(() => {
      ref.current!.hookValue.handleParticipantSelect(participant);
    });
    expect(ref.current!.getFormState().selectedParticipants).toEqual([]);
  });

  it("navigates to category management when add-new action selected", () => {
    const navigationModule = require("@react-navigation/native");
    const navigate = jest.fn();
    (navigationModule.useNavigation as jest.Mock).mockReturnValue({ navigate });

    const Harness = buildHarness(participants);
    const ref = createRef<HookHandle>();

    act(() => {
      TestRenderer.create(<Harness ref={ref} />);
    });

    act(() => {
      ref.current!.hookValue.handleCategorySelect(
        ref.current!.hookValue.ADD_NEW_CATEGORY_ACTION,
      );
    });

    expect(navigate).toHaveBeenCalledWith("ManageCategoriesScreen");
    (navigationModule.useNavigation as jest.Mock).mockReset();
  });
});
