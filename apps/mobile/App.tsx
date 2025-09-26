debugger;
import 'react-native-gesture-handler';
import 'react-native-reanimated';
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import HomeScreen from './src/screens/HomeScreen';
import AddExpenseScreen from './src/screens/AddExpenseScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import GroupDetailScreen from './src/screens/GroupDetailScreen';
import ExpenseInsightsScreen from './src/screens/ExpenseInsightsScreen'; // Import ExpenseInsightsScreen
import ManageCategoriesScreen from './src/screens/ManageCategoriesScreen'; // Import ManageCategoriesScreen
import { Expense } from './src/types';

// Define RootStackParamList
export type RootStackParamList = {
  Main: undefined; // For the Tab Navigator
  AddExpense: { expense?: Expense } | undefined;
  GroupDetail: { groupId: string };
  ExpenseInsights: {
    contextType: 'personal' | 'group';
    contextId: string;
    initialDate?: Date;
  };
  ManageCategoriesScreen: undefined; // Add ManageCategoriesScreen
};

const Tab = createBottomTabNavigator(); // Tab navigator type can be inferred or defined separately if needed
const Stack = createStackNavigator<RootStackParamList>(); // Use RootStackParamList

function MainTabs() {
  return (
    <Tab.Navigator id={undefined}>
      <Tab.Screen
        name='History'
        component={HistoryScreen}
        options={{ title: 'Group' }}
      />
      <Tab.Screen
        name='Home'
        component={HomeScreen}
        options={{ title: 'Expense' }}
      />
      <Tab.Screen name='Settings' component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator id={undefined}>
        <Stack.Screen
          name='Main'
          component={MainTabs}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name='AddExpense'
          component={AddExpenseScreen}
          options={{ title: 'Add/Edit Expense' }}
        />
        <Stack.Screen name='GroupDetail' component={GroupDetailScreen} />
        <Stack.Screen
          name='ExpenseInsights'
          component={ExpenseInsightsScreen}
        />
        <Stack.Screen
          name='ManageCategoriesScreen'
          component={ManageCategoriesScreen}
          options={{ title: 'Manage Categories' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
