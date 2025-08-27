import { useState, useMemo } from "react";
import { useNavigation } from "@react-navigation/native";
import { StackNavigationProp } from "@react-navigation/stack";
import { ExpenseCategory, Participant, ExpenseGroup } from "../types";
import { DEFAULT_CATEGORIES } from "../constants/expenses";
import { RootStackParamList } from "../../App";

const ADD_NEW_CATEGORY_ACTION = "+ Add New Category" as const;

interface UseExpenseModalsProps {
  formState: {
    category: ExpenseCategory;
    selectedGroup: ExpenseGroup | null;
    paidByParticipant: Participant | null;
    selectedParticipants: Participant[];
  };
  participants: Participant[];
  handleUpdateFormState: (field: string, value: any) => void;
  setFormState: React.Dispatch<React.SetStateAction<any>>;
}

export const useExpenseModals = ({
  formState,
  participants,
  handleUpdateFormState,
  setFormState,
}: UseExpenseModalsProps) => {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList, "AddExpense">>();

  // Modal visibility state
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showPaidByModal, setShowPaidByModal] = useState(false);
  const [showSplitModal, setShowSplitModal] = useState(false);

  // Participants available for selection depend on the selected group
  const availableParticipants = useMemo(() => {
    return formState.selectedGroup
      ? formState.selectedGroup.participants
      : participants;
  }, [formState.selectedGroup, participants]);

  // Category modal data
  const categoryModalData = useMemo(() => {
    const categoryNames = DEFAULT_CATEGORIES.map((cat) => cat.name);
    return [...categoryNames, ADD_NEW_CATEGORY_ACTION];
  }, []);

  // Modal handlers
  const handleCategorySelect = (item: ExpenseCategory | typeof ADD_NEW_CATEGORY_ACTION) => {
    if (item === ADD_NEW_CATEGORY_ACTION) {
      navigation.navigate("ManageCategoriesScreen");
    } else {
      handleUpdateFormState("category", item);
    }
  };

  const handleGroupSelect = (item: ExpenseGroup) => {
    handleUpdateFormState("selectedGroup", item);
    handleUpdateFormState("paidByParticipant", null);
    handleUpdateFormState("selectedParticipants", []);
  };

  const handleGroupClear = () => {
    handleUpdateFormState("selectedGroup", null);
    handleUpdateFormState("paidByParticipant", null);
    handleUpdateFormState("selectedParticipants", []);
    setShowGroupModal(false);
  };

  const handleParticipantSelect = (item: Participant) => {
    setFormState((prev: any) => {
      const isSelected = prev.selectedParticipants.some((p: Participant) => p.id === item.id);
      return {
        ...prev,
        selectedParticipants: isSelected
          ? prev.selectedParticipants.filter((p: Participant) => p.id !== item.id)
          : [...prev.selectedParticipants, item],
      };
    });
  };

  return {
    // Modal visibility state
    showCategoryModal,
    setShowCategoryModal,
    showGroupModal,
    setShowGroupModal,
    showPaidByModal,
    setShowPaidByModal,
    showSplitModal,
    setShowSplitModal,
    
    // Computed data
    availableParticipants,
    categoryModalData,
    
    // Modal handlers
    handleCategorySelect,
    handleGroupSelect,
    handleGroupClear,
    handleParticipantSelect,
    
    // Constants
    ADD_NEW_CATEGORY_ACTION,
  };
};