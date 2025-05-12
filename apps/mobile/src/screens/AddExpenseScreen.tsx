import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, Button } from "react-native";
import { RouteProp, useRoute } from "@react-navigation/native";

// Import types and constants
import { Expense, Participant, ExpenseGroup, ExpenseCategory } from "../types";
import { EXPENSE_CATEGORIES } from "../constants/expenses";

// Import custom hook and components
import { useExpenseForm } from "../hooks/useExpenseForm";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import ParticipantTag from "../components/ParticipantTag";
import SelectionModal from "../components/SelectionModal";
import DatePicker from "../components/DatePicker";

// Define route params type if not already defined globally
type AddExpenseRouteParams = {
  AddExpense: { expense?: Expense };
};

const AddExpenseScreen = () => {
  // Get route params safely
  const route = useRoute<RouteProp<AddExpenseRouteParams, "AddExpense">>();
  const editingExpense = route.params?.expense;

  // --- Use the custom form hook ---
  const {
    formState,
    setFormState, // Get setFormState for direct updates from modals
    handleUpdateFormState,
    handleRemoveParticipant,
    onChangeDate,
    handleSubmit,
    isEditing,
    groups, // Get groups and participants from the hook for modals
    participants,
  } = useExpenseForm({ editingExpense });

  // --- Modal Visibility State ---
  // (Could potentially be moved to another hook like useModalState if reused)
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showPaidByModal, setShowPaidByModal] = useState(false);
  const [showSplitModal, setShowSplitModal] = useState(false);

  // --- Derived state for modals ---
  // Participants available for selection depend on the selected group
  const availableParticipants = useMemo(() => {
    return formState.selectedGroup
      ? formState.selectedGroup.participants
      : participants; // Or maybe all participants if no group? Decide logic.
    // For now, let's assume only group participants if group is selected
    // return formState.selectedGroup ? formState.selectedGroup.participants : [];
  }, [formState.selectedGroup, participants]);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={styles.container}>
        {/* --- Form Inputs using reusable components --- */}
        <FormInput
          label="Title:"
          value={formState.title}
          onChangeText={(value) => handleUpdateFormState("title", value)}
          placeholder="Enter expense title"
        />

        <FormInput
          label="Amount:"
          value={formState.amount}
          onChangeText={(value) => handleUpdateFormState("amount", value)}
          placeholder="Enter amount"
          keyboardType="numeric"
        />

        <SelectInput
          label="Category:"
          selectedValue={formState.category}
          onPress={() => setShowCategoryModal(true)}
        />

        <SelectInput
          label="Group (optional):"
          selectedValue={formState.selectedGroup?.name}
          placeholder="Select Group"
          onPress={() => setShowGroupModal(true)}
        />

        {/* Only show Paid By and Split Between if a group is selected */}
        {formState.selectedGroup && (
          <>
            <SelectInput
              label="Paid By:"
              selectedValue={formState.paidByParticipant?.name}
              placeholder="Select Payer"
              onPress={() => setShowPaidByModal(true)}
              // Disable if no participants in group?
              // disabled={availableParticipants.length === 0}
            />

            <Text style={styles.label}>Split Between:</Text>
            <View style={styles.selectedParticipantsContainer}>
              {formState.selectedParticipants.map((participant) => (
                <ParticipantTag
                  key={participant.id}
                  participantName={participant.name}
                  onRemove={() => handleRemoveParticipant(participant.id)}
                />
              ))}
              <SelectInput
                label="" // No label needed for the button part
                selectedValue="+ Add" // Display text for the button
                onPress={() => setShowSplitModal(true)}
                containerStyle={styles.addParticipantButtonContainer}
                valueStyle={styles.addParticipantButtonText}
                // Disable if no participants in group?
                // disabled={availableParticipants.length === 0}
              />
            </View>
          </>
        )}

        <FormInput
          label="Caption (optional):"
          value={formState.caption}
          onChangeText={(value) => handleUpdateFormState("caption", value)}
          placeholder="Add a note about this expense"
          multiline
          numberOfLines={3}
        />

        <DatePicker
          label="Date:"
          date={formState.date}
          onChange={onChangeDate}
        />

        {/* --- Submit Button --- */}
        <View style={styles.buttonContainer}>
          <Button
            title={isEditing ? "Update Expense" : "Add Expense"}
            onPress={handleSubmit}
          />
        </View>
      </ScrollView>

      {/* --- Modals using reusable component --- */}

      {/* Category Modal */}
      <SelectionModal<ExpenseCategory>
        visible={showCategoryModal}
        title="Select Category"
        data={EXPENSE_CATEGORIES as unknown as ExpenseCategory[]} // Need to cast because EXPENSE_CATEGORIES is readonly
        renderItemContent={(item) => (
          <Text style={styles.modalItemText}>{item}</Text>
        )}
        keyExtractor={(item) => item}
        isSelected={(item) => formState.category === item}
        onSelect={(item) => handleUpdateFormState("category", item)}
        onClose={() => setShowCategoryModal(false)}
      />

      {/* Group Modal */}
      <SelectionModal<ExpenseGroup>
        visible={showGroupModal}
        title="Select Group"
        data={groups}
        renderItemContent={(item) => (
          <Text style={styles.modalItemText}>{item.name}</Text>
        )}
        keyExtractor={(item) => item.id}
        isSelected={(item) => formState.selectedGroup?.id === item.id}
        onSelect={(item) => {
          // Reset paidBy and splitBetween when group changes
          handleUpdateFormState("selectedGroup", item);
          handleUpdateFormState("paidByParticipant", null);
          handleUpdateFormState("selectedParticipants", []);
        }}
        onClose={() => setShowGroupModal(false)}
        onClearSelection={() => {
          handleUpdateFormState("selectedGroup", null);
          handleUpdateFormState("paidByParticipant", null);
          handleUpdateFormState("selectedParticipants", []);
          setShowGroupModal(false); // Close after clearing
        }}
      />

      {/* Paid By Modal */}
      <SelectionModal<Participant>
        visible={showPaidByModal && !!formState.selectedGroup} // Only show if group selected
        title="Who Paid?"
        data={availableParticipants}
        renderItemContent={(item) => (
          <Text style={styles.modalItemText}>{item.name}</Text>
        )}
        keyExtractor={(item) => item.id}
        isSelected={(item) => formState.paidByParticipant?.id === item.id}
        onSelect={(item) => handleUpdateFormState("paidByParticipant", item)}
        onClose={() => setShowPaidByModal(false)}
      />

      {/* Split Between Modal */}
      <SelectionModal<Participant>
        visible={showSplitModal && !!formState.selectedGroup} // Only show if group selected
        title="Split Between"
        data={availableParticipants}
        renderItemContent={(item) => (
          <Text style={styles.modalItemText}>{item.name}</Text>
        )}
        keyExtractor={(item) => item.id}
        isSelected={(item) =>
          formState.selectedParticipants.some((p) => p.id === item.id)
        }
        onSelect={(item) => {
          // Toggle selection for multi-select
          setFormState((prev) => {
            const isSelected = prev.selectedParticipants.some(
              (p) => p.id === item.id
            );
            return {
              ...prev,
              selectedParticipants: isSelected
                ? prev.selectedParticipants.filter((p) => p.id !== item.id)
                : [...prev.selectedParticipants, item],
            };
          });
        }}
        onClose={() => setShowSplitModal(false)}
        multiSelect={true} // Enable multi-select behavior
      />
    </View>
  );
};

// --- Styles --- (Keep relevant layout styles, component styles are internal)
const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  label: {
    // Keep label style if needed outside components (like for Split Between)
    fontSize: 16,
    marginBottom: 5,
    color: "#333",
    fontWeight: "500",
  },
  selectedParticipantsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center", // Align tags and button
    marginBottom: 15,
    // Add styling for the container if needed, e.g., border
    // borderWidth: 1,
    // borderColor: '#eee',
    // padding: 10,
    // borderRadius: 5,
  },
  addParticipantButtonContainer: {
    marginBottom: 0, // Remove default margin from SelectInput container
    borderWidth: 0, // Remove border for button-like appearance
    paddingVertical: 0, // Adjust padding
    minHeight: 0,
  },
  addParticipantButtonText: {
    color: "#007bff", // Style like a link/button
    fontSize: 16,
    padding: 8, // Add padding for touch area
  },
  buttonContainer: {
    marginTop: 20, // Add some space before the final button
    marginBottom: 40, // Extra space at the bottom
  },
  modalItemText: {
    // Style for text inside modal list items
    fontSize: 16,
    paddingVertical: 5, // Add some vertical padding inside the item touchable
  },
  // Remove old styles that are now handled by individual components
  // (e.g., input, inputContainer, selectText, dateText, modal styles, category styles, etc.)
});

export default AddExpenseScreen;
