import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { PieChart } from "react-native-gifted-charts";
import { ChartDataPoint } from "../../utils/calculations/insightCalculations";

interface CategoryChartProps {
  data: ChartDataPoint[];
  showLegend?: boolean;
}

const CategoryChart: React.FC<CategoryChartProps> = ({ 
  data, 
  showLegend = true 
}) => {
  if (data.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.chartContainer}>
          <Text style={styles.noDataText}>
            No expense data for the selected period.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.chartContainer}>
        <PieChart
          data={data}
          donut
          focusOnPress
          showText
          textColor="black"
          textSize={10}
        />
      </View>

      {showLegend && (
        <View style={styles.legendContainer}>
          {data.map((item) => (
            <View key={item.category} style={styles.legendItem}>
              <View
                style={[styles.legendColorBox, { backgroundColor: item.color }]}
              />
              <Text style={styles.legendText}>
                {item.category}: ${item.absoluteValue.toFixed(2)} (
                {item.percentage.toFixed(1)}%)
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 15,
    marginBottom: 20,
  },
  chartContainer: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 200,
    marginBottom: 15,
  },
  noDataText: {
    fontSize: 16,
    color: "#666",
    textAlign: "center",
    fontStyle: "italic",
  },
  legendContainer: {
    marginTop: 10,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    paddingHorizontal: 5,
  },
  legendColorBox: {
    width: 16,
    height: 16,
    borderRadius: 3,
    marginRight: 10,
  },
  legendText: {
    fontSize: 14,
    color: "#333",
    flex: 1,
  },
});

export default CategoryChart;