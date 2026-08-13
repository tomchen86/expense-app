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
import {
  getExpenseAmountMinor,
  getExpenseCurrency,
  getExpenseShares,
  getExpenseSpaceId,
  getPersonalExpenseProjection,
  isExpenseDeleted,
} from '../../src/utils/expenseDomain';
import { formatMinorUnits } from '../../src/utils/money';

const HomeScreen = () => {
  const expenses = useExpenseStore((state) => state.expenses);
  const participants = useExpenseStore((state) => state.participants);
  const _userSettings = useExpenseStore((state) => state.userSettings);
  const groups = useExpenseStore((state) => state.groups);
  const deleteExpense = useExpenseStore((state) => state.deleteExpense);
  const internalUserId = useExpenseStore((state) => state.internalUserId);
  const personalParticipantId = useExpenseStore(
    (state) => state.personalParticipantId,
  );
  const personalSpaceId = useExpenseStore((state) => state.personalSpaceId);

  const currentParticipantIds = useMemo(
    () =>
      Array.from(
        new Set([
          personalParticipantId,
          ...participants
            .filter((participant) => participant.userId === internalUserId)
            .map((participant) => participant.id),
        ]),
      ),
    [internalUserId, participants, personalParticipantId],
  );

  const relevantExpenses = useMemo(() => {
    return expenses.filter(
      (expense) =>
        !isExpenseDeleted(expense) &&
        ((expense.spaceKind === 'personal' &&
          getExpenseSpaceId(expense) === personalSpaceId) ||
          currentParticipantIds.some(
            (participantId) =>
              getPersonalExpenseProjection(expense, participantId) !== null,
          )),
    );
  }, [expenses, personalSpaceId, currentParticipantIds]);

  const totalUserShares = useMemo(() => {
    const totals = new Map<string, number>();
    relevantExpenses.forEach((expense) => {
      const currency = getExpenseCurrency(expense);
      totals.set(
        currency,
        (totals.get(currency) ?? 0) +
          (expense.spaceKind === 'personal' &&
          getExpenseSpaceId(expense) === personalSpaceId
            ? getExpenseAmountMinor(expense)
            : getExpenseShares(expense)
                .filter((share) =>
                  currentParticipantIds.includes(share.participantId),
                )
                .reduce((sum, share) => sum + share.amountMinor, 0)),
      );
    });
    return [...totals.entries()];
  }, [relevantExpenses, currentParticipantIds, personalSpaceId]);

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
    const groupForDisplay = getExpenseSpaceId(item)
      ? groupMap.get(getExpenseSpaceId(item)!)
      : null;
    const userShareMinor =
      item.spaceKind === 'personal' &&
      getExpenseSpaceId(item) === personalSpaceId
        ? getExpenseAmountMinor(item)
        : getExpenseShares(item)
            .filter((share) =>
              currentParticipantIds.includes(share.participantId),
            )
            .reduce((sum, share) => sum + share.amountMinor, 0);

    return (
      <ExpenseListItem
        item={item}
        group={groupForDisplay ?? null}
        allParticipants={participants}
        displayAmountMinor={userShareMinor}
        currency={getExpenseCurrency(item)}
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
          {totalUserShares.length === 0 ? (
            <Text style={styles.totalExpensesText}>Your Total Share: —</Text>
          ) : (
            totalUserShares.map(([currency, amountMinor]) => (
              <Text key={currency} style={styles.totalExpensesText}>
                Your Total Share: {formatMinorUnits(amountMinor, currency)}
              </Text>
            ))
          )}
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
    boxShadow: '0 1px 1.41px rgba(0, 0, 0, 0.2)',
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
