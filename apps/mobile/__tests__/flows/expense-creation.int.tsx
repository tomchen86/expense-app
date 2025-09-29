import { renderRouter, screen } from 'expo-router/testing-library';
import React from 'react';
import { Text, Pressable } from 'react-native';
import { router } from 'expo-router';

// Mock components for testing
const HomeScreen = () => (
  <>
    <Text testID='home-screen'>Home Screen</Text>
    <Pressable
      testID='add-expense-button'
      onPress={() => router.push('/add-expense')}
    >
      <Text>Add Expense</Text>
    </Pressable>
  </>
);

const AddExpenseScreen = () => (
  <>
    <Text testID='add-expense-screen'>Add Expense Screen</Text>
    <Pressable testID='back-button' onPress={() => router.back()}>
      <Text>Back</Text>
    </Pressable>
  </>
);

const RootLayout = ({ children }: { children: React.ReactNode }) => children;

describe('Expense Creation Flow', () => {
  it('navigates from home to add-expense screen', async () => {
    await renderRouter(
      {
        'app/_layout': RootLayout,
        'app/(tabs)/index': HomeScreen,
        'app/add-expense': AddExpenseScreen,
      },
      {
        initialUrl: '/',
      },
    );

    // Should start on home screen
    expect(await screen.findByTestId('home-screen')).toBeTruthy();
    expect(screen).toHavePathname('/');

    // Navigate to add expense
    const addButton = await screen.findByTestId('add-expense-button');
    await screen.user.press(addButton);

    // Should be on add expense screen
    expect(await screen.findByTestId('add-expense-screen')).toBeTruthy();
    expect(screen).toHavePathname('/add-expense');
  });

  it('navigates back from add-expense screen', async () => {
    await renderRouter(
      {
        'app/_layout': RootLayout,
        'app/(tabs)/index': HomeScreen,
        'app/add-expense': AddExpenseScreen,
      },
      {
        initialUrl: '/add-expense',
      },
    );

    // Should start on add expense screen
    expect(await screen.findByTestId('add-expense-screen')).toBeTruthy();
    expect(screen).toHavePathname('/add-expense');

    // Navigate back
    const backButton = await screen.findByTestId('back-button');
    await screen.user.press(backButton);

    // Should be back on home screen
    expect(await screen.findByTestId('home-screen')).toBeTruthy();
    expect(screen).toHavePathname('/');
  });
});
