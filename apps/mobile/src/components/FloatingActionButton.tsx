import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ViewStyle } from 'react-native';
import { router } from 'expo-router';

interface FloatingActionButtonProps {
  onPress?: () => void; // Custom press action
  style?: ViewStyle;
  groupId?: string; // Optional groupId to pass to AddExpense screen
}

const FloatingActionButton: React.FC<FloatingActionButtonProps> = ({
  onPress,
  style,
  groupId,
}) => {
  const handlePress = () => {
    if (onPress) {
      onPress();
    } else {
      if (groupId) {
        router.push({
          pathname: '/add-expense',
          params: { groupId },
        });
      } else {
        router.push('/add-expense');
      }
    }
  };

  return (
    <TouchableOpacity style={[styles.fab, style]} onPress={handlePress}>
      <Text style={styles.fabText}>+</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    bottom: 25,
    // right: 25, // Removed to allow centering
    alignSelf: 'center', // Center horizontally
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#007bff', // Example color, adjust as needed
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8, // For Android shadow
    shadowColor: '#000', // For iOS shadow
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    opacity: 0.85, // Slightly transparent
  },
  fabText: {
    fontSize: 30,
    color: 'white',
    lineHeight: 30, // Adjust for vertical centering of '+'
  },
});

export default FloatingActionButton;
