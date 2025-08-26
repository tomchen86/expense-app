import React, { useState } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Modal,
  Animated, // For swipe animations
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useNavigation } from "@react-navigation/native";
import { StackNavigationProp } from "@react-navigation/stack";
import { useExpenseStore } from "../store/expenseStore";
import { Category } from "../types";

// Define ParamList for this screen and potential navigations from it
type ManageCategoriesStackParamList = {
  ManageCategoriesScreen: undefined;
  // Add other screens if needed
};

type ManageCategoriesNavigationProp = StackNavigationProp<
  ManageCategoriesStackParamList,
  "ManageCategoriesScreen"
>;

// Simple Color Picker (can be replaced with a more sophisticated one)
const COLORS = [
  "#FF6384",
  "#36A2EB",
  "#FFCE56",
  "#4BC0C0",
  "#9966FF",
  "#FF9F40",
  "#C9CBCF",
  "#61C0BF",
  "#F7464A",
  "#46BFBD",
  "#FDB45C",
  "#949FB1",
];

const ManageCategoriesScreen = () => {
  const navigation = useNavigation<ManageCategoriesNavigationProp>();
  const {
    categories,
    addCategory,
    updateCategory,
    deleteCategory,
    getCategoryByName,
  } = useExpenseStore();

  const [modalVisible, setModalVisible] = useState(false);
  const [isEditing, setIsEditing] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [selectedColor, setSelectedColor] = useState(COLORS[0]);

  const handleOpenModal = (category?: Category) => {
    if (category) {
      setIsEditing(category);
      setCategoryName(category.name);
      setSelectedColor(category.color);
    } else {
      setIsEditing(null);
      setCategoryName("");
      setSelectedColor(COLORS[0]);
    }
    setModalVisible(true);
  };

  const handleSaveCategory = () => {
    if (!categoryName.trim()) {
      Alert.alert("Error", "Category name cannot be empty.");
      return;
    }

    if (!isEditing && getCategoryByName(categoryName.trim())) {
      Alert.alert("Error", "A category with this name already exists.");
      return;
    }
    if (
      isEditing &&
      isEditing.name !== categoryName.trim() &&
      getCategoryByName(categoryName.trim())
    ) {
      Alert.alert("Error", "Another category with this name already exists.");
      return;
    }

    if (isEditing) {
      updateCategory({
        ...isEditing,
        name: categoryName.trim(),
        color: selectedColor,
      });
    } else {
      addCategory({ name: categoryName.trim(), color: selectedColor });
    }
    setModalVisible(false);
  };

  const handleDeleteCategory = (categoryId: string) => {
    const categoryToDelete = categories.find((c) => c.id === categoryId);
    if (categoryToDelete && categoryToDelete.name === "Other") {
      Alert.alert("Error", "The 'Other' category cannot be deleted.");
      return;
    }
    Alert.alert(
      "Delete Category",
      "Are you sure you want to delete this category? Expenses using it might be affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteCategory(categoryId),
        },
      ]
    );
  };

  const renderCategoryItem = ({ item }: { item: Category }) => {
    const renderRightActions = (
      progress: Animated.AnimatedInterpolation<number>,
      dragX: Animated.AnimatedInterpolation<number>
    ) => {
      const trans = dragX.interpolate({
        inputRange: [-80, 0], // Swipe distance to reveal button
        outputRange: [0, 80], // How much the button itself translates
        extrapolate: "clamp",
      });
      return (
        <TouchableOpacity
          onPress={() => handleDeleteCategory(item.id)}
          style={styles.deleteButton}
        >
          <Animated.Text
            style={[
              styles.deleteButtonText,
              {
                transform: [{ translateX: trans }],
              },
            ]}
          >
            Delete
          </Animated.Text>
        </TouchableOpacity>
      );
    };

    if (item.name === "Other") {
      // "Other" category is not swipeable for delete and has a simpler layout
      // It's still tappable to edit its color or name (though name change for "Other" might be restricted).
      return (
        <TouchableOpacity
          style={styles.itemContainer}
          onPress={() => handleOpenModal(item)}
          activeOpacity={0.7}
        >
          <View style={[styles.colorDot, { backgroundColor: item.color }]} />
          <Text style={styles.itemName}>{item.name}</Text>
        </TouchableOpacity>
      );
    }

    return (
      <Swipeable
        renderRightActions={renderRightActions}
        overshootRight={false}
        containerStyle={styles.swipeableContainer}
      >
        <TouchableOpacity
          style={styles.itemContentContainer}
          onPress={() => handleOpenModal(item)}
          activeOpacity={0.7}
        >
          <View style={[styles.colorDot, { backgroundColor: item.color }]} />
          <Text style={styles.itemName}>{item.name}</Text>
        </TouchableOpacity>
      </Swipeable>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={categories}
        renderItem={renderCategoryItem}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No categories found.</Text>
        }
      />
      <TouchableOpacity
        style={styles.addButton}
        onPress={() => handleOpenModal()}
      >
        <Text style={styles.addButtonText}>+ Add New Category</Text>
      </TouchableOpacity>

      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {isEditing ? "Edit" : "Add"} Category
            </Text>
            <TextInput
              style={styles.input}
              placeholder="Category Name"
              value={categoryName}
              onChangeText={setCategoryName}
            />
            <Text style={styles.colorPickerLabel}>Select Color:</Text>
            <View style={styles.colorPickerContainer}>
              {COLORS.map((color) => (
                <TouchableOpacity
                  key={color}
                  style={[
                    styles.colorOption,
                    { backgroundColor: color },
                    selectedColor === color && styles.selectedColorOption,
                  ]}
                  onPress={() => setSelectedColor(color)}
                />
              ))}
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.saveButton]}
                onPress={handleSaveCategory}
              >
                <Text style={styles.modalButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 15,
    backgroundColor: "#f5f5f5",
  },
  itemContainer: {
    // This style is now for the non-swipeable "Other" or the inner content of swipeable
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    padding: 15,
    borderRadius: 8, // Apply border radius here if swipeableContainer doesn't have it
    // marginBottom is handled by swipeableContainer or FlatList's ItemSeparatorComponent
  },
  itemContentContainer: {
    // Used for the tappable area inside Swipeable
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    padding: 15,
    borderRadius: 8,
  },
  swipeableContainer: {
    // Container for the Swipeable component itself
    marginBottom: 10,
    borderRadius: 8, // Important for clipping the delete button
    overflow: "hidden", // Ensures delete button is clipped by borderRadius
    elevation: 1, // Keep elevation on the outer container
  },
  colorDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginRight: 15,
  },
  itemName: {
    flex: 1,
    fontSize: 16,
  },
  // itemActions, actionButton, actionText, deleteText are removed.
  deleteButton: {
    backgroundColor: "#dc3545",
    justifyContent: "center",
    alignItems: "center", // Center text in button
    width: 80, // Fixed width for the delete button
    // borderRadius: 8, // Should be handled by swipeableContainer's overflow:hidden
    // No marginBottom here, swipeableContainer handles it.
  },
  deleteButtonText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
  },
  addButton: {
    backgroundColor: "#007bff",
    padding: 15,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 10,
  },
  addButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },
  emptyText: {
    textAlign: "center",
    marginTop: 20,
    fontSize: 16,
    color: "#666",
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  modalContent: {
    width: "90%",
    backgroundColor: "white",
    borderRadius: 10,
    padding: 20,
    alignItems: "stretch",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 20,
    textAlign: "center",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    padding: 10,
    fontSize: 16,
    borderRadius: 6,
    marginBottom: 15,
  },
  colorPickerLabel: {
    fontSize: 16,
    marginBottom: 10,
  },
  colorPickerContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-around",
    marginBottom: 20,
  },
  colorOption: {
    width: 30,
    height: 30,
    borderRadius: 15,
    margin: 5,
    borderWidth: 1,
    borderColor: "#eee",
  },
  selectedColorOption: {
    borderColor: "#007bff",
    borderWidth: 2,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  modalButton: {
    flex: 1,
    padding: 10,
    borderRadius: 6,
    alignItems: "center",
    marginHorizontal: 5,
  },
  cancelButton: {
    backgroundColor: "#6c757d",
  },
  saveButton: {
    backgroundColor: "#007bff",
  },
  modalButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
  },
});

export default ManageCategoriesScreen;
