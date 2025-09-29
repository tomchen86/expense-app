import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Pressable as _Pressable,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Stack } from 'expo-router';

import { useExpenseStore } from '../src/store/expenseStore';
import {
  Expense,
  ExpenseGroup,
  Participant as _Participant,
} from '../src/types';
import ExpenseListItem from '../src/components/ExpenseListItem';
import GroupBalancesOverlay from '../src/components/GroupBalancesOverlay';
import FloatingActionButton from '../src/components/FloatingActionButton';
import {
  calculateGroupTotal,
  calculateUserTotalContributionInGroup,
} from '../src/utils/groupCalculations';

const GroupDetailScreen = () => {
  const params = useLocalSearchParams();
  const { groupId } = params;

  const expenses = useExpenseStore((state) => state.expenses);
  const groups = useExpenseStore((state) => state.groups);
  const deleteExpense = useExpenseStore((state) => state.deleteExpense);
  const internalUserId = useExpenseStore((state) => state.internalUserId);
  const allParticipants = useExpenseStore((state) => state.participants);

  const [isBalancesOverlayVisible, setIsBalancesOverlayVisible] =
    useState(false);

  const group = useMemo(() => {
    return groups.find((g) => g.id === groupId);
  }, [groups, groupId]);

  const groupExpenses = useMemo(() => {
    return expenses.filter((e) => e.groupId === groupId);
  }, [expenses, groupId]);

  const groupTotal = useMemo(() => {
    return calculateGroupTotal(groupExpenses, groupId as string);
  }, [groupExpenses, groupId]);

  const currentUserTotalContribution = useMemo(() => {
    if (!internalUserId) {
      return 0;
    }
    return calculateUserTotalContributionInGroup(
      internalUserId,
      groupExpenses,
      groupId as string,
    );
  }, [internalUserId, groupExpenses, groupId]);

  const groupMembers = useMemo(() => {
    return group?.participants || [];
  }, [group]);

  const _groupMap = useMemo(() => {
    const map = new Map<string, ExpenseGroup>();
    if (group) {
      map.set(group.id, group);
    }
    return map;
  }, [group]);

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
    return (
      <ExpenseListItem
        item={item}
        group={group ?? null}
        allParticipants={allParticipants}
        displayAmount={item.amount}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    );
  };

  if (!group) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Group Details' }} />
        <Text style={styles.errorText}>Group not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: group.name }} />

      <TouchableOpacity
        onPress={() =>
          router.push({
            pathname: '/insights',
            params: {
              contextType: 'group',
              contextId: groupId as string,
            },
          })
        }
      >
        <View style={styles.totalContainer}>
          <Text style={styles.totalText}>
            Group Total: ${groupTotal.toFixed(2)}
          </Text>
        </View>
      </TouchableOpacity>

      {internalUserId && (
        <TouchableOpacity
          onPress={() => setIsBalancesOverlayVisible(true)}
          style={styles.totalContainer}
        >
          <Text style={styles.totalText}>
            My Total Contribution: ${currentUserTotalContribution.toFixed(2)}
          </Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={groupExpenses}
        renderItem={renderExpenseListItem}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <Text style={styles.emptyListText}>
            No expenses in this group yet.
          </Text>
        }
        style={styles.list}
      />

      {group && internalUserId && (
        <GroupBalancesOverlay
          visible={isBalancesOverlayVisible}
          onClose={() => setIsBalancesOverlayVisible(false)}
          members={groupMembers}
          expenses={groupExpenses}
          currentUserId={internalUserId}
        />
      )}
      <FloatingActionButton groupId={groupId as string} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  totalContainer: {
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
  totalText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  list: {
    flex: 1,
  },
  emptyListText: {
    textAlign: 'center',
    marginTop: 50,
    fontSize: 16,
    color: '#6c757d',
  },
  errorText: {
    textAlign: 'center',
    marginTop: 50,
    fontSize: 18,
    color: 'red',
  },
});

export default GroupDetailScreen;
