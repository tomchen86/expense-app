import React, { useEffect } from 'react';
import { StyleSheet, ScrollView } from 'react-native';
import { RouteProp, useRoute, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';

import { Expense } from '../types';
import { useInsightsData } from '../hooks/useInsightsData';
import CategoryChart from '../components/insights/CategoryChart';
import InsightsHeader from '../components/insights/InsightsHeader';
import DatePickerModal from '../components/insights/DatePickerModal';

type RootStackParamList = {
  Home: undefined;
  AddExpense: { expense?: Expense } | undefined;
  History: undefined;
  GroupDetail: { groupId: string };
  ExpenseInsights: {
    contextType: 'personal' | 'group';
    contextId: string;
    initialDate?: Date;
  };
  Settings: undefined;
  Main: undefined;
};

type ExpenseInsightsScreenRouteProp = RouteProp<
  RootStackParamList,
  'ExpenseInsights'
>;

const ExpenseInsightsScreen = () => {
  const route = useRoute<ExpenseInsightsScreenRouteProp>();
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();

  const { contextType, contextId, initialDate } = route.params;

  const insightsData = useInsightsData({
    contextType,
    contextId,
    initialDate,
  });

  useEffect(() => {
    navigation.setOptions({ title: insightsData.screenTitle });
  }, [navigation, insightsData.screenTitle]);

  return (
    <ScrollView style={styles.container}>
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
