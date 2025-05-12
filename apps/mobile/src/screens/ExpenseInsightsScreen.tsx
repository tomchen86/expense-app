import React, { useState, useMemo, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from "react-native"; // Added TouchableOpacity
import { RouteProp, useRoute, useNavigation } from "@react-navigation/native";
import { StackNavigationProp } from "@react-navigation/stack";

import { useExpenseStore } from "../store/expenseStore";
import { Expense, ExpenseCategory, ExpenseGroup } from "../types";
import { Picker } from "@react-native-picker/picker"; // Import Picker

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

  const [aggregation, setAggregation] = useState<"month" | "year">("month");
  const [selectedYear, setSelectedYear] = useState<number>(
    initialDate ? initialDate.getFullYear() : new Date().getFullYear()
  );
  const [selectedMonth, setSelectedMonth] = useState<number>(
    initialDate ? initialDate.getMonth() : new Date().getMonth()
  ); // 0-11

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

  const filteredExpenses = useMemo(() => {
    let relevantExpenses: Expense[] = [];
    if (contextType === "personal" && internalUserId) {
      relevantExpenses = allExpenses.filter(
        (e) => e.groupId === internalUserId
      );
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

    const colors = [
      "#FF6384",
      "#36A2EB",
      "#FFCE56",
      "#4BC0C0",
      "#9966FF",
      "#FF9F40",
      "#C9CBCF",
      "#61C0BF",
    ];
    let colorIndex = 0;

    return Object.entries(aggregated).map(([category, value]) => ({
      value: value || 0,
      label: category,
      text: `${category}: ${(((value || 0) / totalForPeriod) * 100).toFixed(
        1
      )}%`,
      color: colors[colorIndex++ % colors.length],
      category: category as ExpenseCategory,
      absoluteValue: value || 0,
      percentage: ((value || 0) / totalForPeriod) * 100,
    }));
  }, [filteredExpenses]);

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.headerText}>{screenTitle}</Text>

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

        <View style={styles.dateSelectorsContainer}>
          {aggregation === "month" && (
            <View style={styles.pickerContainer}>
              <Text style={styles.dateSelectorLabel}>Month:</Text>
              <Picker
                selectedValue={selectedMonth}
                style={styles.picker}
                onValueChange={(itemValue) => setSelectedMonth(itemValue)}
                itemStyle={styles.pickerItem} // For iOS item styling
              >
                {monthNames.map((month, index) => (
                  <Picker.Item key={index} label={month} value={index} />
                ))}
              </Picker>
            </View>
          )}
          <View style={styles.pickerContainer}>
            <Text style={styles.dateSelectorLabel}>Year:</Text>
            <Picker
              selectedValue={selectedYear}
              style={styles.picker}
              onValueChange={(itemValue) => setSelectedYear(itemValue)}
              itemStyle={styles.pickerItem} // For iOS item styling
            >
              {availableYears.map((year) => (
                <Picker.Item key={year} label={year.toString()} value={year} />
              ))}
            </Picker>
          </View>
        </View>
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
          <Text>Legend:</Text>
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
  dateSelectorsContainer: {
    flexDirection: "row",
    justifyContent: "space-around", // Or 'space-between'
    alignItems: "center",
  },
  pickerContainer: {
    // Renamed from dateSelector for clarity
    flexDirection: "row",
    alignItems: "center",
    // paddingVertical: 5, // Keep or adjust as needed
    flex: 1, // Allow picker to take available space within its part of the row
    marginHorizontal: 5, // Add some spacing between pickers
  },
  picker: {
    flex: 1, // Take available width in the pickerContainer
    height: 50, // Standard picker height, adjust as needed
    // backgroundColor: '#f0f0f0', // Optional: for visibility during layout
    // For Android, wrapper View might be needed for certain styles
  },
  pickerItem: {
    // For iOS: style individual picker items (font size, color)
    // height: 120, // Example: if you want taller items on iOS
    // fontSize: 16,
  },
  dateSelectorLabel: {
    fontSize: 16,
    marginRight: 8,
    color: "#333",
  },
  // dateSelectorValue style is no longer needed as it's replaced by Picker
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
