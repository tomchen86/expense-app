import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Button,
  TouchableOpacity,
  Platform,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useExpenseStore } from "../store/expenseStore";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";

const AddExpenseScreen = () => {
  const navigation = useNavigation();
  const addExpenseToStore = useExpenseStore((state) => state.addExpense);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  const handleAddExpense = () => {
    if (!title || !amount || !date) {
      // Basic validation, consider adding more robust validation and user feedback
      alert("Please fill all fields.");
      return;
    }
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount)) {
      alert("Amount must be a number.");
      return;
    }
    addExpenseToStore({
      title,
      amount: numericAmount,
      date: date.toISOString().split("T")[0],
    });
    console.log("Expense Added:", {
      title,
      amount: numericAmount,
      date: date.toISOString().split("T")[0],
    });
    navigation.goBack();
  };

  const onChangeDate = (event: DateTimePickerEvent, selectedDate?: Date) => {
    const currentDate = selectedDate || date;
    setShowDatePicker(Platform.OS === "ios");
    setDate(currentDate);
  };

  const showDatepicker = () => {
    setShowDatePicker(true);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Title:</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter expense title"
        value={title}
        onChangeText={setTitle}
      />
      <Text style={styles.label}>Amount:</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter amount"
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
      />
      <Text style={styles.label}>Date:</Text>
      <TouchableOpacity onPress={showDatepicker} style={styles.inputContainer}>
        <Text style={styles.dateText}>{date.toLocaleDateString()}</Text>
      </TouchableOpacity>
      {showDatePicker && (
        <DateTimePicker
          testID="dateTimePicker"
          value={date}
          mode={"date"}
          is24Hour={true}
          display="default"
          onChange={onChangeDate}
        />
      )}
      <Button title="Add Expense" onPress={handleAddExpense} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    // justifyContent: "center", // Remove or adjust as needed
    // alignItems: "center", // Remove or adjust as needed
  },
  label: {
    fontSize: 16,
    marginBottom: 5,
  },
  input: {
    height: 40,
    borderColor: "gray",
    borderWidth: 1,
    marginBottom: 15,
    paddingHorizontal: 10,
    borderRadius: 5,
  },
  inputContainer: {
    height: 40,
    borderColor: "gray",
    borderWidth: 1,
    marginBottom: 15,
    paddingHorizontal: 10,
    borderRadius: 5,
    justifyContent: "center",
  },
  dateText: {
    fontSize: 16,
  },
});

export default AddExpenseScreen;
