import {
  calculateGroupTotal,
  calculateUserTotalContributionInGroup,
  calculateAllMemberBalancesInGroup,
} from "../groupCalculations";
import type { Expense, Participant } from "../../types";

describe("groupCalculations", () => {
  const members: Participant[] = [
    { id: "user-1", name: "Alice" },
    { id: "user-2", name: "Bob" },
    { id: "user-3", name: "Chris" },
  ];

  const expenses: Expense[] = [
    {
      id: "1",
      title: "Dinner",
      amount: 90,
      date: "2025-01-01",
      category: "Food & Dining",
      groupId: "group-1",
      paidBy: "user-1",
      participants: members,
    },
    {
      id: "2",
      title: "Groceries",
      amount: 45,
      date: "2025-01-02",
      category: "Food & Dining",
      groupId: "group-1",
      paidBy: "user-2",
      participants: members.slice(0, 2),
    },
    {
      id: "3",
      title: "Travel",
      amount: 120,
      date: "2025-01-03",
      category: "Travel",
      groupId: "group-2",
      paidBy: "user-3",
    },
  ];

  it("calculates the total for a specific group", () => {
    expect(calculateGroupTotal(expenses, "group-1")).toBe(135);
    expect(calculateGroupTotal(expenses, "group-2")).toBe(120);
  });

  it("calculates user contribution within a group", () => {
    expect(
      calculateUserTotalContributionInGroup("user-1", expenses, "group-1"),
    ).toBe(90);
    expect(
      calculateUserTotalContributionInGroup("user-2", expenses, "group-1"),
    ).toBe(45);
    expect(
      calculateUserTotalContributionInGroup("user-3", expenses, "group-1"),
    ).toBe(0);
  });

  it("calculates balances for each member", () => {
    const groupExpenses = expenses.filter((exp) => exp.groupId === "group-1");
    const balances = calculateAllMemberBalancesInGroup(members, groupExpenses);

    const alice = balances.find((balance) => balance.memberId === "user-1");
    const bob = balances.find((balance) => balance.memberId === "user-2");
    const chris = balances.find((balance) => balance.memberId === "user-3");

    expect(alice).toMatchObject({ totalPaid: 90 });
    expect(bob).toMatchObject({ totalPaid: 45 });
    expect(chris).toMatchObject({ totalPaid: 0 });

    const totalShares = balances.map((balance) => balance.totalShare);
    expect(totalShares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(135);
  });

  it("returns empty balances when no members provided", () => {
    const result = calculateAllMemberBalancesInGroup([], expenses);
    expect(result).toEqual([]);
  });
});
