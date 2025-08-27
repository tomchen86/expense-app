import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";

interface InsightsHeaderProps {
  aggregation: "month" | "year";
  onAggregationChange: (aggregation: "month" | "year") => void;
  displayPeriodText: string;
  onPeriodPress: () => void;
  onPreviousPeriod: () => void;
  onNextPeriod: () => void;
  isNextDisabled: boolean;
}

const InsightsHeader: React.FC<InsightsHeaderProps> = ({
  aggregation,
  onAggregationChange,
  displayPeriodText,
  onPeriodPress,
  onPreviousPeriod,
  onNextPeriod,
  isNextDisabled,
}) => {
  return (
    <View style={styles.controlsContainer}>
      <View style={styles.aggregationToggleContainer}>
        <TouchableOpacity
          style={[
            styles.aggregationButton,
            aggregation === "month" && styles.aggregationButtonActive,
          ]}
          onPress={() => onAggregationChange("month")}
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
          onPress={() => onAggregationChange("year")}
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

      <View style={styles.periodNavigatorContainer}>
        <TouchableOpacity
          onPress={onPreviousPeriod}
          style={styles.periodArrowButton}
        >
          <Text style={styles.periodArrowText}>{"<"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onPeriodPress}>
          <Text style={styles.periodDisplayText}>{displayPeriodText}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onNextPeriod}
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
    </View>
  );
};

const styles = StyleSheet.create({
  controlsContainer: {
    marginBottom: 20,
    padding: 10,
    backgroundColor: "#fff",
    borderRadius: 8,
    paddingVertical: 15,
  },
  aggregationToggleContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: 15,
    borderWidth: 1,
    borderColor: "#007bff",
    borderRadius: 8,
    overflow: "hidden",
  },
  aggregationButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  aggregationButtonActive: {
    backgroundColor: "#007bff",
  },
  aggregationButtonText: {
    color: "#007bff",
    fontWeight: "600",
  },
  aggregationButtonTextActive: {
    color: "#fff",
  },
  periodNavigatorContainer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  periodArrowButton: {
    padding: 10,
    paddingHorizontal: 15,
  },
  periodArrowText: {
    fontSize: 18,
    color: "#007bff",
    fontWeight: "bold",
  },
  disabledArrowButton: {
    opacity: 0.3,
  },
  disabledArrowText: {
    color: "#ccc",
  },
  periodDisplayText: {
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    paddingHorizontal: 20,
    textAlign: "center",
    minWidth: 150,
  },
});

export default InsightsHeader;