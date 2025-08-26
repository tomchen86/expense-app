import React, { useState, useMemo, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform, // Added Platform
  Modal, // Added Modal
  Button, // Added Button for the modal's Done button
} from "react-native";
import { RouteProp, useRoute, useNavigation } from "@react-navigation/native";
import { StackNavigationProp } from "@react-navigation/stack";

import { useExpenseStore } from "../store/expenseStore";
import { Expense, ExpenseCategory, ExpenseGroup } from "../types";
import { Picker } from "@react-native-picker/picker"; // Re-import Picker

import { PieChart } from "react-native-gifted-charts";

// TODO: Import or define Picker/SegmentedControl components

// Define ParamList locally for now, including this screen and its params
// TODO: This should ideally be defined in a central navigation types file
type RootStackParamList = {
  Home: undefined;
  AddExpense: { expense?: Expense } | undefined;
  History: undefined;
  GroupDetail: { groupId: string };
  ExpenseInsights: {
    contextType: "personal" | "group";
    contextId: string; // internalUserId or groupId
    initialDate?: Date;
  };
  // Add other screens from your App.tsx RootStackParamList if they are navigated to from here
  Settings: undefined; // Assuming Settings is a screen name
  Main: undefined; // Assuming Main (for tabs) is a screen name
};

type ExpenseInsightsScreenRouteProp = RouteProp<
  RootStackParamList,
  "ExpenseInsights"
>;

const ExpenseInsightsScreen = () => {
  const route = useRoute<ExpenseInsightsScreenRouteProp>();
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();

  const { contextType, contextId, initialDate } = route.params;

  const allExpenses = useExpenseStore((state) => state.expenses);
  const internalUserId = useExpenseStore((state) => state.internalUserId);
  const groups = useExpenseStore((state) => state.groups);
  const appCategories = useExpenseStore((state) => state.categories); // Get categories from store

  const [aggregation, setAggregation] = useState<"month" | "year">("month");
  const [selectedYear, setSelectedYear] = useState<number>(
    initialDate ? initialDate.getFullYear() : new Date().getFullYear()
  );
  const [selectedMonth, setSelectedMonth] = useState<number>(
    initialDate ? initialDate.getMonth() : new Date().getMonth()
  ); // 0-11
  const [showDatePickers, setShowDatePickers] = useState(false); // State for picker visibility

  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let i = currentYear - 5; i <= currentYear + 5; i++) {
      years.push(i);
    }
    return years;
  }, []);

  const monthNames = useMemo(
    () => [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
    []
  );

  const screenTitle = useMemo(() => {
    if (contextType === "group") {
      const group = groups.find((g) => g.id === contextId);
      return group ? `${group.name} Insights` : "Group Insights";
    }
    return "Personal Expense Insights";
  }, [contextType, contextId, groups]);

  useEffect(() => {
    navigation.setOptions({ title: screenTitle });
  }, [navigation, screenTitle]);

  const handlePreviousPeriod = () => {
    if (aggregation === "month") {
      let newMonth = selectedMonth - 1;
      let newYear = selectedYear;
      if (newMonth < 0) {
        newMonth = 11; // December
        newYear -= 1;
      }
      setSelectedMonth(newMonth);
      setSelectedYear(newYear);
    } else {
      // year
      setSelectedYear(selectedYear - 1);
    }
  };

  const handleNextPeriod = () => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-11

    if (aggregation === "month") {
      let newMonth = selectedMonth + 1;
      let newYear = selectedYear;
      if (newMonth > 11) {
        newMonth = 0; // January
        newYear += 1;
      }
      // Prevent going past the current month and year
      if (
        newYear > currentYear ||
        (newYear === currentYear && newMonth > currentMonth)
      ) {
        return; // Do nothing if next period is in the future
      }
      setSelectedMonth(newMonth);
      setSelectedYear(newYear);
    } else {
      // year
      let newYear = selectedYear + 1;
      // Prevent going past the current year
      if (newYear > currentYear) {
        return; // Do nothing if next year is in the future
      }
      setSelectedYear(newYear);
    }
  };

  const displayPeriodText = useMemo(() => {
    if (aggregation === "month") {
      return `${monthNames[selectedMonth]} ${selectedYear}`;
    }
    return selectedYear.toString();
  }, [selectedMonth, selectedYear, aggregation, monthNames]);

  const isNextDisabled = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    if (aggregation === "month") {
      return (
        selectedYear > currentYear ||
        (selectedYear === currentYear && selectedMonth >= currentMonth)
      );
    }
    return selectedYear >= currentYear;
  }, [selectedYear, selectedMonth, aggregation]);

  const filteredExpenses = useMemo(() => {
    let relevantExpenses: Expense[] = [];
    if (contextType === "personal" && internalUserId) {
      // For personal insights, show all expenses paid by the user,
      // including those in actual groups and those marked as "personal" (where groupId === internalUserId)
      relevantExpenses = allExpenses.filter((e) => e.paidBy === internalUserId);
    } else if (contextType === "group") {
      relevantExpenses = allExpenses.filter((e) => e.groupId === contextId);
    }

    return relevantExpenses.filter((e) => {
      const expenseDate = new Date(e.date);
      if (aggregation === "year") {
        return expenseDate.getFullYear() === selectedYear;
      } else {
        // month
        return (
          expenseDate.getFullYear() === selectedYear &&
          expenseDate.getMonth() === selectedMonth
        );
      }
    });
  }, [
    allExpenses,
    contextType,
    contextId,
    internalUserId,
    aggregation,
    selectedYear,
    selectedMonth,
  ]);

  const chartData = useMemo(() => {
    if (filteredExpenses.length === 0) return [];

    const aggregated: { [key in ExpenseCategory]?: number } = {};
    let totalForPeriod = 0;

    filteredExpenses.forEach((expense) => {
      aggregated[expense.category] =
        (aggregated[expense.category] || 0) + expense.amount;
      totalForPeriod += expense.amount;
    });

    if (totalForPeriod === 0) return [];

    // Default color for categories not found in store (should not happen ideally)
    const DEFAULT_COLOR = "#808080"; // Grey

    return Object.entries(aggregated).map(([categoryName, value]) => {
      const categoryDetails = appCategories.find(
        (c) => c.name === categoryName
      );
      return {
        value: value || 0,
        label: categoryName,
        text: categoryName, // Display only the category name
        color: categoryDetails ? categoryDetails.color : DEFAULT_COLOR,
        category: categoryName as ExpenseCategory,
        absoluteValue: value || 0,
        percentage: ((value || 0) / totalForPeriod) * 100,
      };
    });
  }, [filteredExpenses, appCategories]);

  return (
    <ScrollView style={styles.container}>
      {/* <Text style={styles.headerText}>{screenTitle}</Text> Removed redundant title */}

      <View style={styles.controlsContainer}>
        <View style={styles.aggregationToggleContainer}>
          <TouchableOpacity
            style={[
              styles.aggregationButton,
              aggregation === "month" && styles.aggregationButtonActive,
            ]}
            onPress={() => setAggregation("month")}
          >
            <Text
              style={[
                styles.aggregationButtonText,
                aggregation === "month" && styles.aggregationButtonTextActive,
              ]}
            >
              By Month
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.aggregationButton,
              aggregation === "year" && styles.aggregationButtonActive,
            ]}
            onPress={() => setAggregation("year")}
          >
            <Text
              style={[
                styles.aggregationButtonText,
                aggregation === "year" && styles.aggregationButtonTextActive,
              ]}
            >
              By Year
            </Text>
          </TouchableOpacity>
        </View>

        {/* New Date Navigator */}
        <View style={styles.periodNavigatorContainer}>
          <TouchableOpacity
            onPress={handlePreviousPeriod}
            style={styles.periodArrowButton}
          >
            <Text style={styles.periodArrowText}>{"<"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowDatePickers(!showDatePickers)}
          >
            <Text style={styles.periodDisplayText}>{displayPeriodText}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleNextPeriod}
            disabled={isNextDisabled}
            style={[
              styles.periodArrowButton,
              isNextDisabled && styles.disabledArrowButton,
            ]}
          >
            <Text
              style={[
                styles.periodArrowText,
                isNextDisabled && styles.disabledArrowText,
              ]}
            >
              {">"}
            </Text>
          </TouchableOpacity>
        </View>
        {/* End of New Date Navigator */}

        {/* Modal for Date Pickers */}
        <Modal
          transparent={true}
          visible={showDatePickers}
          animationType="slide"
          onRequestClose={() => setShowDatePickers(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Select Period</Text>
              {aggregation === "month" && (
                <View style={styles.pickerContainerModal}>
                  <Text style={styles.dateSelectorLabel}>Month:</Text>
                  <Picker
                    selectedValue={selectedMonth}
                    style={styles.pickerModal}
                    onValueChange={(itemValue) => setSelectedMonth(itemValue)}
                    itemStyle={styles.pickerItem}
                  >
                    {monthNames.map((month, index) => (
                      <Picker.Item key={index} label={month} value={index} />
                    ))}
                  </Picker>
                </View>
              )}
              <View style={styles.pickerContainerModal}>
                <Text style={styles.dateSelectorLabel}>Year:</Text>
                <Picker
                  selectedValue={selectedYear}
                  style={styles.pickerModal}
                  onValueChange={(itemValue) => setSelectedYear(itemValue)}
                  itemStyle={styles.pickerItem}
                >
                  {availableYears.map((year) => (
                    <Picker.Item
                      key={year}
                      label={year.toString()}
                      value={year}
                    />
                  ))}
                </Picker>
              </View>
              <Button title="Done" onPress={() => setShowDatePickers(false)} />
            </View>
          </View>
        </Modal>
      </View>

      <View style={styles.chartContainer}>
        {chartData.length > 0 ? (
          <PieChart
            data={chartData}
            donut // Makes it a donut chart
            focusOnPress // Highlights slice on press
            showText // Shows the 'text' property from data on slices
            textColor="black"
            textSize={10} // Adjust as needed
            // textBackgroundRadius={10} // Optional: if text needs a background
            // onLabelPress={(item) => console.log(item)} // Optional: for custom press actions
            // radius={120} // Adjust overall size
            // innerRadius={60} // Adjust donut hole size
            // showTextBackground
            // textBackgroundColor="white"
          />
        ) : (
          <Text style={styles.noDataText}>
            No expense data for the selected period.
          </Text>
        )}
      </View>

      {chartData.length > 0 && (
        <View style={styles.legendContainer}>
          {chartData.map((item) => (
            <View key={item.category} style={styles.legendItem}>
              <View
                style={[styles.legendColorBox, { backgroundColor: item.color }]}
              />
              <Text>
                {item.category}: ${item.absoluteValue.toFixed(2)} (
                {item.percentage.toFixed(1)}%)
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 15,
    backgroundColor: "#f5f5f5",
  },
  headerText: {
    fontSize: 22,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 20,
  },
  controlsContainer: {
    marginBottom: 20,
    padding: 10,
    backgroundColor: "#fff",
    borderRadius: 8,
    paddingVertical: 15, // Increased padding
  },
  aggregationToggleContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: 15,
    borderWidth: 1,
    borderColor: "#007bff",
    borderRadius: 8,
    overflow: "hidden", // Ensures children adhere to border radius
  },
  aggregationButton: {
    flex: 1, // Each button takes equal width
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "#fff", // Default background
  },
  aggregationButtonActive: {
    backgroundColor: "#007bff", // Active background
  },
  aggregationButtonText: {
    color: "#007bff", // Default text color
    fontWeight: "600",
  },
  aggregationButtonTextActive: {
    color: "#fff", // Active text color
  },
  // Styles for dateSelectorsContainer, pickerContainer, picker, pickerItem, dateSelectorLabel
  // are kept as they are now used by the pickers inside the modal,
  // but we might need to adjust them or add new styles for modal context.
  dateSelectorsContainer: {
    // This style is now for the container *inside* the modal
    flexDirection: "column", // Changed to column for modal layout
    justifyContent: "center",
    alignItems: "stretch", // Stretch items to fill width
    width: "100%", // Ensure it takes full width of modal content
    marginBottom: 15,
  },
  pickerContainerModal: {
    // New style for pickers inside modal
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10, // Space between pickers if month and year are shown
    width: "100%",
  },
  pickerModal: {
    // New style for picker element inside modal
    flex: 1,
    height: Platform.OS === "ios" ? 180 : 50, // iOS pickers are taller
    // backgroundColor: '#f0f0f0', // For debugging, to see picker bounds
  },
  pickerItem: {
    // This style is primarily for iOS Picker items
    color: "#000000", // Explicitly set item text color to black for iOS
    // fontSize: 16, // Example
  },
  dateSelectorLabel: {
    fontSize: 16,
    color: "#000000", // Explicitly set label text color to black
    marginRight: Platform.OS === "ios" ? 8 : 4,
    // Consider a fixed width for labels if alignment is an issue
    // width: 60,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  modalContent: {
    backgroundColor: "white",
    padding: 20,
    borderRadius: 10,
    width: "80%",
    alignItems: "stretch", // Align items like pickers to stretch
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 15,
    textAlign: "center",
  },
  periodNavigatorContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 10, // Add some margin if needed
    // borderWidth: 1,
    // borderColor: 'blue',
  },
  periodArrowButton: {
    paddingHorizontal: 15,
    paddingVertical: 8,
    // backgroundColor: '#ddd', // Example style
    borderRadius: 5,
  },
  disabledArrowButton: {
    // backgroundColor: '#f0f0f0', // Lighter background for disabled state
  },
  periodArrowText: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#007bff",
  },
  disabledArrowText: {
    color: "#aaa", // Greyed out text for disabled state
  },
  periodDisplayText: {
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    textAlign: "center",
    flex: 1, // Allow text to take available space and center
  },
  chartContainer: {
    alignItems: "center",
    justifyContent: "center",
    height: 300,
    marginBottom: 20,
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 10,
  },
  legendContainer: {
    padding: 10,
    backgroundColor: "#fff",
    borderRadius: 8,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 5,
  },
  legendColorBox: {
    width: 15,
    height: 15,
    marginRight: 8,
  },
  noDataText: {
    fontSize: 16,
    color: "#666",
    textAlign: "center",
  },
});

export default ExpenseInsightsScreen;
