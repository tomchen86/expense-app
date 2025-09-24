import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { useExpenseStore } from '../store/expenseStore';

// Define a local param list for navigation from this screen
type SettingsStackParamList = {
  SettingsScreen: undefined; // Current screen
  ManageCategoriesScreen: undefined; // Screen to navigate to
  // Add other screens if SettingsScreen navigates elsewhere
};

type SettingsScreenNavigationProp = StackNavigationProp<
  SettingsStackParamList,
  'SettingsScreen'
>;

const SettingsScreen = () => {
  const navigation = useNavigation<SettingsScreenNavigationProp>();
  const { userSettings, updateUserSettings } = useExpenseStore();
  const [name, setName] = useState(userSettings?.name ?? '');

  const handleSave = () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter your name');
      return;
    }

    updateUserSettings({ name: name.trim() });
    Alert.alert('Success', 'Settings saved successfully');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Your Name:</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder='Enter your name'
      />

      <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
        <Text style={styles.saveButtonText}>Save Settings</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.saveButton, styles.manageCategoriesButton]}
        onPress={() => navigation.navigate('ManageCategoriesScreen')}
      >
        <Text style={styles.saveButtonText}>Manage Categories</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: 'white',
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 8,
  },
  input: {
    height: 40,
    borderColor: 'gray',
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 10,
    marginBottom: 20,
  },
  saveButton: {
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 5,
    alignItems: 'center',
  },
  manageCategoriesButton: {
    marginTop: 15, // Add some space above this button
    backgroundColor: '#5bc0de', // A different color for distinction
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '500',
  },
});

export default SettingsScreen;
