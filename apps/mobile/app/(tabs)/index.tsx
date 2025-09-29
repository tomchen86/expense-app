import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
} from 'react-native';
import { router } from 'expo-router';
import { useExpenseStore } from '../../src/store/expenseStore';
import {
  Expense,
  Participant as _Participant,
  ExpenseGroup,
  UserSettings as _UserSettings,
} from '../../src/types';

import ExpenseListItem from '../../src/components/ExpenseListItem';
import FloatingActionButton from '../../src/components/FloatingActionButton';
import { calculateUserShare } from '../../src/utils/expenseCalculations';

const HomeScreen = () => {
  const expenses = useExpenseStore((state) => state.expenses);
  const participants = useExpenseStore((state) => state.participants);
  const _userSettings = useExpenseStore((state) => state.userSettings);
  const groups = useExpenseStore((state) => state.groups);
  const deleteExpense = useExpenseStore((state) => state.deleteExpense);
  const internalUserId = useExpenseStore((state) => state.internalUserId);

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
    router.push({
      pathname: '/add-expense',
      params: { expense: JSON.stringify(expense) },
    });
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
        allParticipants={participants}
        displayAmount={userShare}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    );
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={() => {
          if (internalUserId) {
            router.push({
              pathname: '/insights',
              params: {
                contextType: 'personal',
                contextId: internalUserId,
              },
            });
          }
        }}
        disabled={!internalUserId}
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
      <FloatingActionButton />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  totalExpensesContainer: {
    backgroundColor: '#ffffff',
    padding: 15,
    borderRadius: 8,
    marginBottom: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
  },
  totalExpensesText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  list: {
    width: '100%',
  },
  noExpensesText: {
    textAlign: 'center',
    marginTop: 50,
    fontSize: 16,
    color: '#6c757d',
  },
});

export default HomeScreen;
