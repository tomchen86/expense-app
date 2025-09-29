import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack>
        <Stack.Screen name='(tabs)' options={{ headerShown: false }} />
        <Stack.Screen
          name='add-expense'
          options={{ title: 'Add/Edit Expense' }}
        />
        <Stack.Screen
          name='group-detail'
          options={{ title: 'Group Details' }}
        />
        <Stack.Screen name='insights' options={{ title: 'Expense Insights' }} />
        <Stack.Screen
          name='manage-categories'
          options={{ title: 'Manage Categories' }}
        />
      </Stack>
      <StatusBar style='auto' />
    </GestureHandlerRootView>
  );
}
