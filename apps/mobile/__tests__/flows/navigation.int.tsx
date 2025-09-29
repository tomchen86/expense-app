import { renderRouter, screen } from 'expo-router/testing-library';
import React from 'react';
import { Text, Pressable } from 'react-native';
import { router } from 'expo-router';

// Mock tab navigation components
const HomeTab = () => (
  <>
    <Text testID='home-tab'>Home Tab</Text>
    <Pressable
      testID='navigate-to-history'
      onPress={() => router.push('/history')}
    >
      <Text>View History</Text>
    </Pressable>
  </>
);

const HistoryTab = () => (
  <>
    <Text testID='history-tab'>History Tab</Text>
    <Pressable
      testID='navigate-to-settings'
      onPress={() => router.push('/settings')}
    >
      <Text>Settings</Text>
    </Pressable>
  </>
);

const SettingsTab = () => (
  <>
    <Text testID='settings-tab'>Settings Tab</Text>
    <Pressable
      testID='manage-categories'
      onPress={() => router.push('/manage-categories')}
    >
      <Text>Manage Categories</Text>
    </Pressable>
  </>
);

const ManageCategoriesScreen = () => (
  <>
    <Text testID='manage-categories-screen'>Manage Categories</Text>
    <Pressable testID='back-to-settings' onPress={() => router.back()}>
      <Text>Back</Text>
    </Pressable>
  </>
);

const RootLayout = ({ children }: { children: React.ReactNode }) => children;

describe('Navigation Flow', () => {
  it('navigates between tab screens', async () => {
    await renderRouter(
      {
        'app/_layout': RootLayout,
        'app/(tabs)/index': HomeTab,
        'app/(tabs)/history': HistoryTab,
        'app/(tabs)/settings': SettingsTab,
      },
      {
        initialUrl: '/',
      },
    );

    // Should start on home tab
    expect(await screen.findByTestId('home-tab')).toBeTruthy();
    expect(screen).toHavePathname('/');

    // Navigate to history
    const historyButton = await screen.findByTestId('navigate-to-history');
    await screen.user.press(historyButton);

    expect(await screen.findByTestId('history-tab')).toBeTruthy();
    expect(screen).toHavePathname('/history');

    // Navigate to settings
    const settingsButton = await screen.findByTestId('navigate-to-settings');
    await screen.user.press(settingsButton);

    expect(await screen.findByTestId('settings-tab')).toBeTruthy();
    expect(screen).toHavePathname('/settings');
  });

  it('navigates to modal screen and back', async () => {
    await renderRouter(
      {
        'app/_layout': RootLayout,
        'app/(tabs)/settings': SettingsTab,
        'app/manage-categories': ManageCategoriesScreen,
      },
      {
        initialUrl: '/settings',
      },
    );

    // Should start on settings
    expect(await screen.findByTestId('settings-tab')).toBeTruthy();
    expect(screen).toHavePathname('/settings');

    // Navigate to manage categories
    const manageCategoriesButton =
      await screen.findByTestId('manage-categories');
    await screen.user.press(manageCategoriesButton);

    expect(await screen.findByTestId('manage-categories-screen')).toBeTruthy();
    expect(screen).toHavePathname('/manage-categories');

    // Navigate back
    const backButton = await screen.findByTestId('back-to-settings');
    await screen.user.press(backButton);

    expect(await screen.findByTestId('settings-tab')).toBeTruthy();
    expect(screen).toHavePathname('/settings');
  });

  it('handles deep linking to specific routes', async () => {
    await renderRouter(
      {
        'app/_layout': RootLayout,
        'app/(tabs)/history': HistoryTab,
        'app/manage-categories': ManageCategoriesScreen,
      },
      {
        initialUrl: '/manage-categories',
      },
    );

    // Should start on manage categories via deep link
    expect(await screen.findByTestId('manage-categories-screen')).toBeTruthy();
    expect(screen).toHavePathname('/manage-categories');
    expect(screen).toHaveSegments(['manage-categories']);
  });
});
