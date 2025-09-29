import React from 'react';
import { StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Stack } from 'expo-router';

import { useInsightsData } from '../src/hooks/useInsightsData';
import CategoryChart from '../src/components/insights/CategoryChart';
import InsightsHeader from '../src/components/insights/InsightsHeader';
import DatePickerModal from '../src/components/insights/DatePickerModal';

const ExpenseInsightsScreen = () => {
  const params = useLocalSearchParams();
  const { contextType, contextId, initialDate } = params;

  const insightsData = useInsightsData({
    contextType: contextType as 'personal' | 'group',
    contextId: contextId as string,
    initialDate: initialDate ? new Date(initialDate as string) : undefined,
  });

  return (
    <ScrollView style={styles.container}>
      <Stack.Screen options={{ title: insightsData.screenTitle }} />

      <InsightsHeader
        aggregation={insightsData.aggregation}
        onAggregationChange={insightsData.setAggregation}
        displayPeriodText={insightsData.displayPeriodText}
        onPeriodPress={() => insightsData.setShowDatePickers(true)}
        onPreviousPeriod={insightsData.handlePreviousPeriod}
        onNextPeriod={insightsData.handleNextPeriod}
        isNextDisabled={insightsData.isNextDisabled}
      />

      <CategoryChart data={insightsData.chartData} />

      <DatePickerModal
        visible={insightsData.showDatePickers}
        onClose={() => insightsData.setShowDatePickers(false)}
        aggregation={insightsData.aggregation}
        selectedYear={insightsData.selectedYear}
        selectedMonth={insightsData.selectedMonth}
        onYearChange={insightsData.setSelectedYear}
        onMonthChange={insightsData.setSelectedMonth}
        availableYears={insightsData.availableYears}
        monthNames={insightsData.monthNames}
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 15,
    backgroundColor: '#f5f5f5',
  },
});

export default ExpenseInsightsScreen;
