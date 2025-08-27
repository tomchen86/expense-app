import React from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";

import { useCategoryManager } from "../hooks/useCategoryManager";
import CategoryForm from "../components/categories/CategoryForm";
import CategoryListItem from "../components/categories/CategoryListItem";
import { Category } from "../types";

const ManageCategoriesScreen = () => {
  const categoryManager = useCategoryManager();

  const renderCategoryItem = ({ item }: { item: Category }) => (
    <CategoryListItem
      category={item}
      onEdit={categoryManager.openEditModal}
      onDelete={categoryManager.deleteCategory}
      canDelete={categoryManager.canDeleteCategory(item)}
    />
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Manage Categories</Text>
      <Text style={styles.subtitle}>
        Tap to edit, swipe left to delete (except "Other")
      </Text>

      <FlatList
        data={categoryManager.categories}
        renderItem={renderCategoryItem}
        keyExtractor={(item) => item.id}
        style={styles.list}
        showsVerticalScrollIndicator={false}
      />

      <TouchableOpacity
        style={styles.addButton}
        onPress={categoryManager.openAddModal}
        activeOpacity={0.8}
      >
        <Text style={styles.addButtonText}>+ Add New Category</Text>
      </TouchableOpacity>

      <CategoryForm
        visible={categoryManager.modalVisible}
        onClose={categoryManager.closeModal}
        onSave={categoryManager.saveCategory}
        editingCategory={categoryManager.isEditing}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    textAlign: "center",
    marginVertical: 20,
    color: "#333",
  },
  subtitle: {
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
    color: "#666",
    paddingHorizontal: 20,
  },
  list: {
    flex: 1,
    backgroundColor: "white",
    marginHorizontal: 15,
    borderRadius: 10,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  addButton: {
    backgroundColor: "#007bff",
    margin: 20,
    padding: 15,
    borderRadius: 10,
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  addButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "600",
  },
});

export default ManageCategoriesScreen;