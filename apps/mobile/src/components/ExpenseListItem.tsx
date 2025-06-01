import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { Expense, ExpenseGroup, Participant } from "../types"; // Import necessary types

interface ExpenseListItemProps {
  item: Expense;
  group: ExpenseGroup | null;
  allParticipants: Participant[]; // Add allParticipants prop
  displayAmount: number; // Add prop for the amount to display (user's share)
  onEdit: (expense: Expense) => void;
  onDelete: (expenseId: string) => void;
}

const ExpenseListItem: React.FC<ExpenseListItemProps> = ({
  item,
  group,
  allParticipants, // Destructure the new prop
  displayAmount,
  onEdit,
  onDelete,
}) => {
  // Safeguard: Ensure allParticipants is defined before calling .find()
  const payer =
    item.paidBy && allParticipants
      ? allParticipants.find((p) => p.id === item.paidBy)
      : null;

  const handleDeletePress = () => {
    Alert.alert(
      "Delete Expense",
      "Are you sure you want to delete this expense?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          onPress: () => onDelete(item.id),
          style: "destructive",
        },
      ]
    );
  };

  return (
    <View style={styles.expenseItem}>
      {/* Main Content Area */}
      <View style={styles.expenseContent}>
        <View style={styles.expenseMain}>
          <Text style={styles.expenseTitle}>{item.title}</Text>
          {/* Use displayAmount for rendering */}
          <Text style={styles.expenseAmount}>${displayAmount.toFixed(2)}</Text>
        </View>
        <View style={styles.expenseDetails}>
          <View style={styles.expenseMetadata}>
            <Text style={styles.expenseCategory}>{item.category}</Text>
            {/* Display group tag if group exists */}
            {group && (
              <View style={styles.groupTag}>
                <Text style={styles.groupTagText}>{group.name}</Text>
              </View>
            )}
          </View>
          {payer && (
            <Text style={styles.paidByText}>Paid by: {payer.name}</Text>
          )}
          <Text style={styles.expenseDate}>{item.date}</Text>
          {/* Display caption if it exists */}
          {item.caption && (
            <Text style={styles.expenseCaption}>{item.caption}</Text>
          )}
        </View>
      </View>

      {/* Action Buttons Area */}
      <View style={styles.actionButtons}>
        <TouchableOpacity
          style={styles.editButton}
          onPress={() => onEdit(item)}
        >
          <Text style={styles.editButtonText}>Edit</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={handleDeletePress}
        >
          <Text style={styles.deleteButtonText}>Delete</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

// Styles copied and adapted from HomeScreen.tsx
const styles = StyleSheet.create({
  expenseItem: {
    backgroundColor: "#ffffff",
    padding: 15,
    borderRadius: 8,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
    // Consider adding flexDirection: 'row' if actions should be beside content
    // flexDirection: 'row',
    // alignItems: 'center',
  },
  expenseContent: {
    flex: 1, // Takes available space if row direction is used
    // marginRight: 10, // Add margin if actions are beside content
  },
  expenseMain: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 5,
  },
  expenseTitle: {
    fontSize: 18,
    fontWeight: "bold",
    // flexShrink: 1, // Allow title to shrink if too long
  },
  expenseAmount: {
    fontSize: 16,
    color: "#28a745", // Green for amount
    fontWeight: "500",
  },
  expenseDetails: {
    // No changes needed here for now
  },
  expenseMetadata: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4, // Add some space above metadata
  },
  expenseCategory: {
    fontSize: 14,
    color: "#666",
  },
  groupTag: {
    backgroundColor: "#e3f2fd", // Light blue background
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  groupTagText: {
    color: "#1976d2", // Blue text
    fontSize: 12,
  },
  expenseDate: {
    fontSize: 14,
    color: "#6c757d",
    marginTop: 4,
  },
  expenseCaption: {
    fontSize: 14,
    color: "#666",
    fontStyle: "italic",
    marginTop: 4,
  },
  paidByText: {
    fontSize: 13,
    color: "#555",
    marginTop: 4,
  },
  actionButtons: {
    flexDirection: "row",
    justifyContent: "flex-end", // Align buttons to the right
    marginTop: 10, // Space between content and buttons
    gap: 10, // Space between buttons
  },
  editButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#007bff", // Blue for edit
    borderRadius: 4,
  },
  editButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "500",
  },
  deleteButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#dc3545", // Red for delete
    borderRadius: 4,
  },
  deleteButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "500",
  },
});

export default ExpenseListItem;
