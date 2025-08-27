import React from "react";
import { Text, StyleSheet } from "react-native";
import { ExpenseCategory, ExpenseGroup, Participant } from "../../types";
import SelectionModal from "../SelectionModal";

interface ExpenseModalsProps {
  // Modal visibility
  showCategoryModal: boolean;
  showGroupModal: boolean;
  showPaidByModal: boolean;
  showSplitModal: boolean;
  
  // Data
  categoryModalData: (ExpenseCategory | string)[];
  groups: ExpenseGroup[];
  availableParticipants: Participant[];
  
  // Current selections
  selectedCategory: ExpenseCategory;
  selectedGroup: ExpenseGroup | null;
  selectedPaidBy: Participant | null;
  selectedParticipants: Participant[];
  
  // Handlers
  onCategorySelect: (item: ExpenseCategory | string) => void;
  onGroupSelect: (item: ExpenseGroup) => void;
  onGroupClear: () => void;
  onPaidBySelect: (item: Participant) => void;
  onParticipantToggle: (item: Participant) => void;
  
  // Close handlers
  onCloseCategoryModal: () => void;
  onCloseGroupModal: () => void;
  onClosePaidByModal: () => void;
  onCloseSplitModal: () => void;
  
  // Constants
  ADD_NEW_CATEGORY_ACTION: string;
}

export const ExpenseModals: React.FC<ExpenseModalsProps> = ({
  showCategoryModal,
  showGroupModal,
  showPaidByModal,
  showSplitModal,
  categoryModalData,
  groups,
  availableParticipants,
  selectedCategory,
  selectedGroup,
  selectedPaidBy,
  selectedParticipants,
  onCategorySelect,
  onGroupSelect,
  onGroupClear,
  onPaidBySelect,
  onParticipantToggle,
  onCloseCategoryModal,
  onCloseGroupModal,
  onClosePaidByModal,
  onCloseSplitModal,
  ADD_NEW_CATEGORY_ACTION,
}) => {
  return (
    <>
      {/* Category Modal */}
      <SelectionModal<ExpenseCategory | string>
        visible={showCategoryModal}
        title="Select Category"
        data={categoryModalData}
        renderItemContent={(item) => (
          <Text style={styles.modalItemText}>{item}</Text>
        )}
        keyExtractor={(item) => item}
        isSelected={(item) =>
          item !== ADD_NEW_CATEGORY_ACTION && selectedCategory === item
        }
        onSelect={onCategorySelect}
        onClose={onCloseCategoryModal}
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
        isSelected={(item) => selectedGroup?.id === item.id}
        onSelect={onGroupSelect}
        onClose={onCloseGroupModal}
        onClearSelection={onGroupClear}
      />

      {/* Paid By Modal */}
      <SelectionModal<Participant>
        visible={showPaidByModal && !!selectedGroup}
        title="Who Paid?"
        data={availableParticipants}
        renderItemContent={(item) => (
          <Text style={styles.modalItemText}>{item.name}</Text>
        )}
        keyExtractor={(item) => item.id}
        isSelected={(item) => selectedPaidBy?.id === item.id}
        onSelect={onPaidBySelect}
        onClose={onClosePaidByModal}
      />

      {/* Split Between Modal */}
      <SelectionModal<Participant>
        visible={showSplitModal && !!selectedGroup}
        title="Split Between"
        data={availableParticipants}
        renderItemContent={(item) => (
          <Text style={styles.modalItemText}>{item.name}</Text>
        )}
        keyExtractor={(item) => item.id}
        isSelected={(item) =>
          selectedParticipants.some((p) => p.id === item.id)
        }
        onSelect={onParticipantToggle}
        onClose={onCloseSplitModal}
        multiSelect={true}
      />
    </>
  );
};

const styles = StyleSheet.create({
  modalItemText: {
    fontSize: 16,
    paddingVertical: 5,
  },
});