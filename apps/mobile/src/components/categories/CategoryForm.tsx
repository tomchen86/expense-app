import React, { useState, useEffect } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal } from "react-native";
import ColorPicker, { DEFAULT_COLORS } from "./ColorPicker";
import { Category } from "../../types";

interface CategoryFormProps {
  visible: boolean;
  onClose: () => void;
  onSave: (name: string, color: string) => void;
  editingCategory?: Category | null;
  title?: string;
}

const CategoryForm: React.FC<CategoryFormProps> = ({
  visible,
  onClose,
  onSave,
  editingCategory,
  title,
}) => {
  const [categoryName, setCategoryName] = useState("");
  const [selectedColor, setSelectedColor] = useState(DEFAULT_COLORS[0]);

  useEffect(() => {
    if (editingCategory) {
      setCategoryName(editingCategory.name);
      setSelectedColor(editingCategory.color);
    } else {
      setCategoryName("");
      setSelectedColor(DEFAULT_COLORS[0]);
    }
  }, [editingCategory, visible]);

  const handleSave = () => {
    const trimmedName = categoryName.trim();
    if (!trimmedName) {
      return; // Don't save empty categories
    }
    
    onSave(trimmedName, selectedColor);
    handleClose();
  };

  const handleClose = () => {
    setCategoryName("");
    setSelectedColor(DEFAULT_COLORS[0]);
    onClose();
  };

  const modalTitle = title || `${editingCategory ? "Edit" : "Add"} Category`;

  return (
    <Modal
      animationType="slide"
      transparent={true}
      visible={visible}
      onRequestClose={handleClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>{modalTitle}</Text>
          
          <TextInput
            style={styles.input}
            placeholder="Category Name"
            value={categoryName}
            onChangeText={setCategoryName}
            autoFocus
            maxLength={50}
          />
          
          <ColorPicker
            selectedColor={selectedColor}
            onColorSelect={setSelectedColor}
          />
          
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.cancelButton]}
              onPress={handleClose}
            >
              <Text style={styles.modalButtonText}>Cancel</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[
                styles.modalButton, 
                styles.saveButton,
                !categoryName.trim() && styles.disabledButton
              ]}
              onPress={handleSave}
              disabled={!categoryName.trim()}
            >
              <Text style={[
                styles.modalButtonText,
                !categoryName.trim() && styles.disabledButtonText
              ]}>
                Save
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  modalContent: {
    backgroundColor: "white",
    padding: 20,
    borderRadius: 15,
    width: "90%",
    maxWidth: 400,
    maxHeight: "80%",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 20,
    color: "#333",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    padding: 15,
    borderRadius: 8,
    fontSize: 16,
    marginBottom: 10,
    backgroundColor: "#f9f9f9",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 20,
  },
  modalButton: {
    padding: 15,
    borderRadius: 8,
    minWidth: 100,
    alignItems: "center",
  },
  cancelButton: {
    backgroundColor: "#6c757d",
  },
  saveButton: {
    backgroundColor: "#007bff",
  },
  disabledButton: {
    backgroundColor: "#ccc",
  },
  modalButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },
  disabledButtonText: {
    color: "#999",
  },
});

export default CategoryForm;