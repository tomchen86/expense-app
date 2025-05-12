import React, { useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { StackNavigationProp } from "@react-navigation/stack";
import { useExpenseStore } from "../store/expenseStore";
import { Expense, Participant, ExpenseGroup, UserSettings } from "../types";

import ExpenseListItem from "../components/ExpenseListItem";
import { calculateUserShare } from "../utils/expenseCalculations";

type RootStackParamList = {
  Home: undefined;
  AddExpense: { expense?: Expense } | undefined;
  GroupDetail: { groupId: string }; // Added from App.tsx for consistency
  ExpenseInsights: {
    contextType: "personal" | "group";
    contextId: string;
    initialDate?: Date;
  };
};

const HomeScreen = () => {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();

  const expenses = useExpenseStore((state) => state.expenses);
  const participants = useExpenseStore((state) => state.participants);
  const userSettings = useExpenseStore((state) => state.userSettings);
  const groups = useExpenseStore((state) => state.groups);
  const deleteExpense = useExpenseStore((state) => state.deleteExpense);
  const internalUserId = useExpenseStore((state) => state.internalUserId);

  // This userParticipant is based on display name, primarily for UI niceties if needed.
  // The core logic for filtering expenses should rely on internalUserId.
  // const userParticipant = useMemo(() => { // Not directly used in filtering anymore
  //   return userSettings?.name
  //     ? participants.find((p) => p.name === userSettings.name)
  //     : null;
  // }, [userSettings, participants]);

  const relevantExpenses = useMemo(() => {
    if (!internalUserId) {
      return [];
    }
    return expenses.filter((expense) => {
      const isPersonalExpense = expense.groupId === internalUserId;
      const isPayerInOtherGroup =
        expense.paidBy === internalUserId && expense.groupId !== internalUserId;
      const isInSplitInOtherGroup =
        expense.groupId !== internalUserId &&
        expense.splitBetween &&
        expense.splitBetween.includes(internalUserId);

      return isPersonalExpense || isPayerInOtherGroup || isInSplitInOtherGroup;
    });
  }, [expenses, internalUserId]);

  const totalUserShare = useMemo(() => {
    return relevantExpenses.reduce((sum, expense) => {
      return sum + calculateUserShare(expense, internalUserId);
    }, 0);
  }, [relevantExpenses, internalUserId]);

  const groupMap = useMemo(() => {
    const map = new Map<string, ExpenseGroup>();
    groups.forEach((group) => {
      if (group.id !== internalUserId) {
        map.set(group.id, group);
      }
    });
    return map;
  }, [groups, internalUserId]);

  const handleEdit = (expense: Expense) => {
    navigation.navigate("AddExpense", { expense });
  };

  const handleDelete = (expenseId: string) => {
    deleteExpense(expenseId);
  };

  const renderExpenseListItem = ({ item }: { item: Expense }) => {
    const groupForDisplay =
      item.groupId && item.groupId !== internalUserId
        ? groupMap.get(item.groupId)
        : null;
    const userShare = calculateUserShare(item, internalUserId);

    return (
      <ExpenseListItem
        item={item}
        group={groupForDisplay ?? null}
        displayAmount={userShare}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    );
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.addButton}
        onPress={() => navigation.navigate("AddExpense")}
      >
        <Text style={styles.addButtonText}>Add New Expense</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => {
          if (internalUserId) {
            navigation.navigate("ExpenseInsights", {
              contextType: "personal",
              contextId: internalUserId,
            });
          }
        }}
        disabled={!internalUserId} // Disable if no user ID
      >
        <View style={styles.totalExpensesContainer}>
          <Text style={styles.totalExpensesText}>
            Your Total Share: ${totalUserShare.toFixed(2)}
          </Text>
        </View>
      </TouchableOpacity>

      {relevantExpenses.length === 0 ? (
        <Text style={styles.noExpensesText}>
          No expenses to display. Add a personal expense or get involved in a
          group expense.
        </Text>
      ) : (
        <FlatList
          data={relevantExpenses}
          renderItem={renderExpenseListItem}
          keyExtractor={(item) => item.id}
          style={styles.list}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: "#f5f5f5",
  },
  addButton: {
    backgroundColor: "#007bff",
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.23,
    shadowRadius: 2.62,
    elevation: 4,
  },
  addButtonText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "bold",
  },
  totalExpensesContainer: {
    backgroundColor: "#ffffff",
    padding: 15,
    borderRadius: 8,
    marginBottom: 20,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
  },
  totalExpensesText: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#333",
  },
  list: {
    width: "100%",
  },
  noExpensesText: {
    textAlign: "center",
    marginTop: 50,
    fontSize: 16,
    color: "#6c757d",
  },
});

export default HomeScreen;
