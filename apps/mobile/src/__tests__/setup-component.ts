// Component testing setup without problematic imports

// Mock React Native modules
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

// Mock react-native-gesture-handler
jest.mock('react-native-gesture-handler', () =>
  require('react-native-gesture-handler/jestSetup'),
);

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  SafeAreaView: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mock Expo modules
jest.mock('expo-status-bar', () => ({
  StatusBar: 'StatusBar',
}));

// Mock React Navigation
jest.mock('@react-navigation/native', () => {
  return {
    ...jest.requireActual('@react-navigation/native'),
    useNavigation: () => ({
      navigate: jest.fn(),
      dispatch: jest.fn(),
      reset: jest.fn(),
      goBack: jest.fn(),
      isFocused: jest.fn(() => true),
      canGoBack: jest.fn(() => true),
      getId: jest.fn(),
      getParent: jest.fn(),
      getState: jest.fn(() => ({ routes: [], index: 0 })),
    }),
    useRoute: () => ({
      key: 'test',
      name: 'test',
      params: {},
    }),
    useFocusEffect: jest.fn(),
  };
});

// Mock React Native SVG
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');

  return {
    default: View,
    Svg: View,
    Circle: View,
    Path: View,
    G: View,
    Text: View,
    Rect: View,
    Line: View,
    Polygon: View,
    Polyline: View,
    Ellipse: View,
    TSpan: View,
    TextPath: View,
    Use: View,
    Image: View,
    Symbol: View,
    Defs: View,
    LinearGradient: View,
    RadialGradient: View,
    Stop: View,
    ClipPath: View,
    Pattern: View,
    Mask: View,
    Marker: View,
    ForeignObject: View,
  };
});

// Mock react-native-gifted-charts
jest.mock('react-native-gifted-charts', () => {
  const React = require('react');
  const { View } = require('react-native');

  return {
    PieChart: (props: any) =>
      React.createElement(View, { testID: 'pie-chart', ...props }),
    BarChart: (props: any) =>
      React.createElement(View, { testID: 'bar-chart', ...props }),
    LineChart: (props: any) =>
      React.createElement(View, { testID: 'line-chart', ...props }),
  };
});

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Mock DateTimePicker
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

// Mock Picker
jest.mock('@react-native-picker/picker', () => ({
  Picker: {
    Item: 'PickerItem',
  },
}));

// Mock Linear Gradient
jest.mock('react-native-linear-gradient', () => 'LinearGradient');

// Global test utilities
global.console = {
  ...console,
  warn: jest.fn(),
  error: jest.fn(),
};

// Setup global test timeout
jest.setTimeout(10000);
