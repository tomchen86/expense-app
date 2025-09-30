import { Tabs } from 'expo-router';
import React from 'react';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name='history'
        options={{
          title: 'Group',
        }}
      />
      <Tabs.Screen
        name='index'
        options={{
          title: 'Expense',
        }}
      />
      <Tabs.Screen
        name='settings'
        options={{
          title: 'Settings',
        }}
      />
    </Tabs>
  );
}
