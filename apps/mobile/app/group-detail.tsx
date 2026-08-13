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
  calculateGroupTotalsByCurrency,
  calculateUserTotalContributionMinorInGroup,
  resolveGroupParticipantIdForUser,
} from '../src/utils/groupCalculations';
import {
  getExpenseAmountMinor,
  getExpenseCurrency,
  getExpenseSpaceId,
  isExpenseDeleted,
} from '../src/utils/expenseDomain';
import { formatMinorUnits } from '../src/utils/money';

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
    return expenses.filter(
      (expense) =>
        !isExpenseDeleted(expense) && getExpenseSpaceId(expense) === groupId,
    );
  }, [expenses, groupId]);

  const groupTotals = useMemo(() => {
    return calculateGroupTotalsByCurrency(groupExpenses, groupId as string);
  }, [groupExpenses, groupId]);

  const currentGroupParticipantId = useMemo(
    () => resolveGroupParticipantIdForUser(group, internalUserId),
    [group, internalUserId],
  );

  const currentUserTotalContributions = useMemo(() => {
    if (!currentGroupParticipantId) {
      return [];
    }
    return calculateUserTotalContributionMinorInGroup(
      currentGroupParticipantId,
      groupExpenses,
      groupId as string,
    );
  }, [currentGroupParticipantId, groupExpenses, groupId]);

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
        displayAmountMinor={getExpenseAmountMinor(item)}
        currency={getExpenseCurrency(item)}
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
          {groupTotals.map((total) => (
            <Text key={total.currency} style={styles.totalText}>
              Group Total: {formatMinorUnits(total.amountMinor, total.currency)}
            </Text>
          ))}
        </View>
      </TouchableOpacity>

      {currentGroupParticipantId && (
        <TouchableOpacity
          onPress={() => setIsBalancesOverlayVisible(true)}
          style={styles.totalContainer}
        >
          {currentUserTotalContributions.map((total) => (
            <Text key={total.currency} style={styles.totalText}>
              My Total Contribution:{' '}
              {formatMinorUnits(total.amountMinor, total.currency)}
            </Text>
          ))}
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

      {group && currentGroupParticipantId && (
        <GroupBalancesOverlay
          visible={isBalancesOverlayVisible}
          onClose={() => setIsBalancesOverlayVisible(false)}
          members={groupMembers}
          expenses={groupExpenses}
          currentUserId={currentGroupParticipantId}
          allParticipants={allParticipants}
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
    boxShadow: '0 1px 1.41px rgba(0, 0, 0, 0.2)',
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
