import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Button,
  FlatList,
  TouchableOpacity,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useExpenseStore, Expense } from "../store/expenseStore";

const HomeScreen = () => {
  const navigation = useNavigation();
  const expenses = useExpenseStore((state) => state.expenses);

  const totalExpenses = expenses.reduce(
    (sum, expense) => sum + expense.amount,
    0
  );

  const renderExpenseItem = ({ item }: { item: Expense }) => (
    <View style={styles.expenseItem}>
      <Text style={styles.expenseTitle}>{item.title}</Text>
      <Text style={styles.expenseAmount}>${item.amount.toFixed(2)}</Text>
      <Text style={styles.expenseDate}>{item.date}</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.addButton}
        onPress={() => navigation.navigate("AddExpense" as never)}
      >
        <Text style={styles.addButtonText}>Add New Expense</Text>
      </TouchableOpacity>
      <View style={styles.totalExpensesContainer}>
        <Text style={styles.totalExpensesText}>
          Total Expenses: ${totalExpenses.toFixed(2)}
        </Text>
      </View>
      {expenses.length === 0 ? (
        <Text style={styles.noExpensesText}>No expenses yet. Add some!</Text>
      ) : (
        <FlatList
          data={expenses}
          renderItem={renderExpenseItem}
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
    shadowOffset: {
      width: 0,
      height: 2,
    },
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
    shadowOffset: {
      width: 0,
      height: 1,
    },
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
  expenseItem: {
    backgroundColor: "#ffffff",
    padding: 15,
    borderRadius: 8,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
  },
  expenseTitle: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 5,
  },
  expenseAmount: {
    fontSize: 16,
    color: "#28a745",
    marginBottom: 3,
  },
  expenseDate: {
    fontSize: 14,
    color: "#6c757d",
  },
  noExpensesText: {
    textAlign: "center",
    marginTop: 50,
    fontSize: 16,
    color: "#6c757d",
  },
});

export default HomeScreen;
