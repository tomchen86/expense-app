import React from "react";
import { View, StyleSheet, ScrollView, Button } from "react-native";
import { RouteProp, useRoute } from "@react-navigation/native";
import { Expense } from "../types";
import { useExpenseForm } from "../hooks/useExpenseForm";
import { useExpenseModals } from "../hooks/useExpenseModals";
import { BasicInfoSection } from "../components/ExpenseForm/BasicInfoSection";
import { GroupSection } from "../components/ExpenseForm/GroupSection";
import { ExpenseModals } from "../components/ExpenseForm/ExpenseModals";

type AddExpenseRouteParams = {
  AddExpense: { expense?: Expense };
};

const AddExpenseScreen = () => {
  const route = useRoute<RouteProp<AddExpenseRouteParams, "AddExpense">>();
  const editingExpense = route.params?.expense;

  const {
    formState,
    setFormState,
    handleUpdateFormState,
    handleRemoveParticipant,
    onChangeDate,
    handleSubmit,
    isEditing,
    groups,
    participants,
  } = useExpenseForm({ editingExpense });

  const {
    showCategoryModal,
    setShowCategoryModal,
    showGroupModal,
    setShowGroupModal,
    showPaidByModal,
    setShowPaidByModal,
    showSplitModal,
    setShowSplitModal,
    availableParticipants,
    categoryModalData,
    handleCategorySelect,
    handleGroupSelect,
    handleGroupClear,
    handleParticipantSelect,
    ADD_NEW_CATEGORY_ACTION,
  } = useExpenseModals({
    formState,
    participants,
    handleUpdateFormState,
    setFormState,
  });

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={styles.container}>
        <BasicInfoSection
          title={formState.title}
          amount={formState.amount}
          category={formState.category}
          caption={formState.caption}
          date={formState.date}
          onTitleChange={(value) => handleUpdateFormState("title", value)}
          onAmountChange={(value) => handleUpdateFormState("amount", value)}
          onCategoryPress={() => setShowCategoryModal(true)}
          onCaptionChange={(value) => handleUpdateFormState("caption", value)}
          onDateChange={onChangeDate}
        />

        <GroupSection
          selectedGroup={formState.selectedGroup}
          paidByParticipant={formState.paidByParticipant}
          selectedParticipants={formState.selectedParticipants}
          onGroupPress={() => setShowGroupModal(true)}
          onPaidByPress={() => setShowPaidByModal(true)}
          onSplitPress={() => setShowSplitModal(true)}
          onRemoveParticipant={handleRemoveParticipant}
        />

        <View style={styles.buttonContainer}>
          <Button
            title={isEditing ? "Update Expense" : "Add Expense"}
            onPress={handleSubmit}
          />
        </View>
      </ScrollView>

      <ExpenseModals
        showCategoryModal={showCategoryModal}
        showGroupModal={showGroupModal}
        showPaidByModal={showPaidByModal}
        showSplitModal={showSplitModal}
        categoryModalData={categoryModalData}
        groups={groups}
        availableParticipants={availableParticipants}
        selectedCategory={formState.category}
        selectedGroup={formState.selectedGroup}
        selectedPaidBy={formState.paidByParticipant}
        selectedParticipants={formState.selectedParticipants}
        onCategorySelect={handleCategorySelect}
        onGroupSelect={handleGroupSelect}
        onGroupClear={handleGroupClear}
        onPaidBySelect={(item) =>
          handleUpdateFormState('paidByParticipant', item)
        }
        onParticipantToggle={handleParticipantSelect}
        onCloseCategoryModal={() => setShowCategoryModal(false)}
        onCloseGroupModal={() => setShowGroupModal(false)}
        onClosePaidByModal={() => setShowPaidByModal(false)}
        onCloseSplitModal={() => setShowSplitModal(false)}
        ADD_NEW_CATEGORY_ACTION={ADD_NEW_CATEGORY_ACTION}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  buttonContainer: {
    marginTop: 20,
    marginBottom: 40,
  },
});

export default AddExpenseScreen;
