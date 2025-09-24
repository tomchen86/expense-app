import React from 'react';
import {
  Modal,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';

interface SelectionModalProps<T> {
  visible: boolean;
  title: string;
  data: T[];
  renderItemContent: (item: T) => React.ReactNode; // Function to render the display text/content of an item
  keyExtractor: (item: T) => string;
  onSelect: (item: T) => void;
  onClose: () => void;
  isSelected: (item: T) => boolean; // Function to check if an item is currently selected
  multiSelect?: boolean; // If true, selecting an item doesn't close the modal immediately
  // Optional: Add props for custom styling or additional buttons if needed
  // Optional: Add a "Clear Selection" button prop
  onClearSelection?: () => void;
}

function SelectionModal<T>({
  visible,
  title,
  data,
  renderItemContent,
  keyExtractor,
  onSelect,
  onClose,
  isSelected,
  multiSelect = false,
  onClearSelection,
}: SelectionModalProps<T>) {
  const handleItemPress = (item: T) => {
    onSelect(item);
    if (!multiSelect) {
      onClose(); // Close immediately for single select
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType='slide'
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{title}</Text>
            <FlatList
              data={data}
              keyExtractor={keyExtractor}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.itemContainer,
                    isSelected(item) && styles.selectedItem, // Highlight selected item(s)
                  ]}
                  onPress={() => handleItemPress(item)}
                >
                  {renderItemContent(item)}
                </TouchableOpacity>
              )}
              style={styles.list}
            />
            <View style={styles.buttonContainer}>
              {onClearSelection && (
                <TouchableOpacity
                  style={styles.clearButton}
                  onPress={onClearSelection}
                >
                  <Text style={styles.buttonText}>Clear</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.closeButton} onPress={onClose}>
                <Text style={styles.buttonText}>
                  {multiSelect ? 'Done' : 'Cancel'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    justifyContent: 'flex-end', // Position modal at the bottom
  },
  modalContainer: {
    flex: 1, // Take full screen height
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)', // Dim background
  },
  modalContent: {
    backgroundColor: 'white',
    borderTopLeftRadius: 15,
    borderTopRightRadius: 15,
    padding: 20,
    maxHeight: '70%', // Limit modal height
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  list: {
    marginBottom: 15,
  },
  itemContainer: {
    paddingVertical: 15,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  selectedItem: {
    backgroundColor: '#e3f2fd', // Light blue for selected item
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between', // Space out buttons
    marginTop: 10,
  },
  closeButton: {
    flex: 1, // Make buttons take equal width if needed
    backgroundColor: '#007bff',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginLeft: 5, // Add space if clear button exists
  },
  clearButton: {
    flex: 1,
    backgroundColor: '#6c757d', // Grey for clear/cancel
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginRight: 5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
  },
});

export default SelectionModal;
