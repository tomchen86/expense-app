import React, { useMemo, useState } from "react"; // Added useState
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Pressable, // Added Pressable for consistency if needed, or use TouchableOpacity
} from "react-native";
import { RouteProp, useRoute, useNavigation } from "@react-navigation/native";
import { StackNavigationProp } from "@react-navigation/stack";

import { useExpenseStore } from "../store/expenseStore";
import { Expense, ExpenseGroup, Participant } from "../types"; // Added Participant
import ExpenseListItem from "../components/ExpenseListItem";
import GroupBalancesOverlay from "../components/GroupBalancesOverlay"; // Import the overlay
import FloatingActionButton from "../components/FloatingActionButton"; // Import FAB
import {
  calculateGroupTotal,
  calculateUserTotalContributionInGroup,
} from "../utils/groupCalculations"; // Added calculateUserTotalContributionInGroup

// Define ParamList including this screen and its params
// TODO: This should ideally be defined in a central navigation types file
type RootStackParamList = {
  Home: undefined;
  AddExpense: { expense?: Expense } | undefined;
  History: undefined; // Assuming HistoryScreen exists in the stack
  GroupDetail: { groupId: string };
  ExpenseInsights: {
    // Added ExpenseInsights for navigation
    contextType: "personal" | "group";
    contextId: string;
    initialDate?: Date;
  };
};

// Define the specific route prop type for this screen
type GroupDetailScreenRouteProp = RouteProp<RootStackParamList, "GroupDetail">;

const GroupDetailScreen = () => {
  const route = useRoute<GroupDetailScreenRouteProp>();
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>(); // For potential actions like editing
  const { groupId } = route.params;

  // --- State from Zustand Store ---
  const expenses = useExpenseStore((state) => state.expenses);
  const groups = useExpenseStore((state) => state.groups);
  const deleteExpense = useExpenseStore((state) => state.deleteExpense);
  const internalUserId = useExpenseStore((state) => state.internalUserId);
  const allParticipants = useExpenseStore((state) => state.participants); // Get all participants

  // --- Component State ---
  const [isBalancesOverlayVisible, setIsBalancesOverlayVisible] =
    useState(false);

  // --- Derived State ---

  // Find the specific group (Memoize)
  const group = useMemo(() => {
    return groups.find((g) => g.id === groupId);
  }, [groups, groupId]);

  // Filter expenses for this group (Memoize)
  const groupExpenses = useMemo(() => {
    return expenses.filter((e) => e.groupId === groupId);
  }, [expenses, groupId]);

  // Calculate total for this group (Memoize)
  const groupTotal = useMemo(() => {
    // Use the utility function, passing only the relevant expenses
    return calculateGroupTotal(groupExpenses, groupId);
  }, [groupExpenses, groupId]);

  const currentUserTotalContribution = useMemo(() => {
    if (!internalUserId) return 0;
    return calculateUserTotalContributionInGroup(
      internalUserId,
      groupExpenses,
      groupId
    );
  }, [internalUserId, groupExpenses, groupId]);

  // Get members of the current group
  const groupMembers = useMemo(() => {
    return group?.participants || [];
  }, [group]);

  // Create a map for quick group lookup (needed by ExpenseListItem)
  const groupMap = useMemo(() => {
    const map = new Map<string, ExpenseGroup>();
    if (group) {
      // Only need the current group in the map for this screen
      map.set(group.id, group);
    }
    return map;
  }, [group]);

  // --- Handlers ---
  const handleEdit = (expense: Expense) => {
    // Navigate to AddExpense screen, passing the expense to edit
    navigation.navigate("AddExpense", { expense });
  };

  const handleDelete = (expenseId: string) => {
    // Call the delete action from the store
    deleteExpense(expenseId);
  };

  // --- Render Logic ---
  const renderExpenseListItem = ({ item }: { item: Expense }) => {
    // Group is already known for all items on this screen
    return (
      <ExpenseListItem
        item={item}
        group={group ?? null}
        allParticipants={allParticipants} // Pass allParticipants
        displayAmount={item.amount} // Pass the full item amount here
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    );
  };

  // Set the header title dynamically
  React.useLayoutEffect(() => {
    navigation.setOptions({ title: group ? group.name : "Group Details" });
  }, [navigation, group]);

  if (!group) {
    // Handle case where group might not be found (e.g., deleted)
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Group not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Display Group Total - Make it Touchable */}
      <TouchableOpacity
        onPress={() =>
          navigation.navigate("ExpenseInsights", {
            contextType: "group",
            contextId: groupId,
          })
        }
      >
        <View style={styles.totalContainer}>
          <Text style={styles.totalText}>
            Group Total: ${groupTotal.toFixed(2)}
          </Text>
        </View>
      </TouchableOpacity>

      {/* Display User's Total Contribution */}
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

      {/* List of Expenses */}
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
      {/* Optional: Add button to add expense directly to this group */}
      {/* <TouchableOpacity style={styles.addButton} onPress={() => navigation.navigate('AddExpense', { defaultGroupId: groupId })}>
           <Text style={styles.addButtonText}>Add Expense to Group</Text>
       </TouchableOpacity> */}

      {/* Group Balances Overlay Modal */}
      {group && internalUserId && (
        <GroupBalancesOverlay
          visible={isBalancesOverlayVisible}
          onClose={() => setIsBalancesOverlayVisible(false)}
          members={groupMembers}
          expenses={groupExpenses}
          currentUserId={internalUserId}
        />
      )}
      <FloatingActionButton groupId={groupId} />
    </View>
  );
};

// --- Styles (borrowed from HomeScreen/HistoryScreen) ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: "#f5f5f5",
  },
  totalContainer: {
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
  totalText: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#333",
  },
  list: {
    flex: 1, // Ensure list takes remaining space
  },
  emptyListText: {
    textAlign: "center",
    marginTop: 50,
    fontSize: 16,
    color: "#6c757d",
  },
  errorText: {
    textAlign: "center",
    marginTop: 50,
    fontSize: 18,
    color: "red",
  },
  // Optional Add Button Styles
  // addButton: { ... },
  // addButtonText: { ... },
});

export default GroupDetailScreen;
