import { useState, useEffect, useMemo } from "react";
import { Platform, Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { useExpenseStore } from "../store/expenseStore";
import { Expense, Participant, ExpenseGroup, ExpenseCategory } from "../types";
import { EXPENSE_CATEGORIES } from "../constants/expenses";

// Define the shape of the form data
interface FormState {
  title: string;
  amount: string;
  date: Date;
  caption: string;
  category: ExpenseCategory;
  selectedGroup: ExpenseGroup | null;
  paidByParticipant: Participant | null;
  selectedParticipants: Participant[];
}

// Define the props for the hook
interface UseExpenseFormProps {
  editingExpense?: Expense | null;
}

export const useExpenseForm = ({ editingExpense }: UseExpenseFormProps) => {
  const navigation = useNavigation();

  // Get data and actions from the Zustand store
  const addExpenseToStore = useExpenseStore((state) => state.addExpense);
  const updateExpenseToStore = useExpenseStore((state) => state.updateExpense);
  const groups = useExpenseStore((state) => state.groups);
  const participants = useExpenseStore((state) => state.participants);
  const userSettings = useExpenseStore((state) => state.userSettings);
  const internalUserId = useExpenseStore((state) => state.internalUserId); // Get internalUserId

  const isEditing = !!editingExpense;

  // Find the current user's participant entry
  const currentUserParticipant = useMemo(() => {
    return userSettings?.name
      ? participants.find((p) => p.name === userSettings.name)
      : null;
  }, [userSettings, participants]);

  // Initialize state with default values
  const [formState, setFormState] = useState<FormState>({
    title: "",
    amount: "",
    date: new Date(),
    caption: "",
    category: EXPENSE_CATEGORIES[0],
    selectedGroup: null,
    paidByParticipant: null,
    selectedParticipants: [],
  });

  // Initialize form state from editingExpense when it changes
  useEffect(() => {
    if (!editingExpense) {
      // Reset form if editingExpense becomes null/undefined (e.g., navigating back)
      setFormState({
        title: "",
        amount: "",
        date: new Date(),
        caption: "",
        category: EXPENSE_CATEGORIES[0],
        selectedGroup: null,
        paidByParticipant: null,
        selectedParticipants: [],
      });
      return;
    }

    const group = editingExpense.groupId
      ? groups.find((g) => g.id === editingExpense.groupId) ?? null
      : null;
    const paidBy = editingExpense.paidBy
      ? participants.find((p) => p.id === editingExpense.paidBy) ?? null
      : null;
    const splitBetween = editingExpense.splitBetween
      ? participants.filter((p) => editingExpense.splitBetween?.includes(p.id))
      : [];

    setFormState({
      title: editingExpense.title,
      amount: editingExpense.amount.toString(),
      date: new Date(editingExpense.date), // Ensure date is a Date object
      caption: editingExpense.caption ?? "",
      category: editingExpense.category,
      selectedGroup: group,
      paidByParticipant: paidBy,
      selectedParticipants: splitBetween,
    });
  }, [editingExpense, groups, participants]); // Rerun effect if these change

  // Generic handler to update any form field
  const handleUpdateFormState = (field: keyof FormState, value: any) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  // Handler to remove a participant from the split list
  const handleRemoveParticipant = (participantId: string) => {
    setFormState((prev) => ({
      ...prev,
      selectedParticipants: prev.selectedParticipants.filter(
        (p) => p.id !== participantId
      ),
    }));
  };

  // Handler for date changes from DateTimePicker
  const onChangeDate = (event: DateTimePickerEvent, selectedDate?: Date) => {
    const currentDate = selectedDate || formState.date;
    // Note: Hiding the picker is usually handled in the component UI state
    setFormState((prev) => ({ ...prev, date: currentDate }));
  };

  // Handler for form submission (add or update)
  const handleSubmit = () => {
    // --- Validation ---
    if (
      !formState.title ||
      !formState.amount ||
      !formState.date ||
      !formState.category
    ) {
      Alert.alert("Validation Error", "Please fill all required fields.");
      return;
    }

    const numericAmount = parseFloat(formState.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      Alert.alert("Validation Error", "Amount must be a positive number.");
      return;
    }

    if (
      formState.selectedGroup &&
      (!formState.paidByParticipant ||
        formState.selectedParticipants.length === 0)
    ) {
      Alert.alert(
        "Validation Error",
        "When adding to a group, please select who paid and who to split with."
      );
      return;
    }
    // --- End Validation ---

    // Determine who paid and the groupId
    let paidById: string | undefined = undefined;
    let groupIdForExpense: string | undefined = undefined;

    if (formState.selectedGroup) {
      // If group expense, use the selected payer and group ID
      paidById = formState.paidByParticipant?.id;
      groupIdForExpense = formState.selectedGroup.id;
    } else {
      // If personal expense, use internalUserId for both paidBy and as the 'personal' groupId
      if (internalUserId) {
        paidById = internalUserId;
        groupIdForExpense = internalUserId; // Personal expenses are grouped under internalUserId
      } else {
        // This case should ideally not happen if internalUserId is always generated.
        // If it does, the expense will have no payer and no group.
        console.warn(
          "[useExpenseForm] internalUserId is null, personal expense will have no payer/group."
        );
      }
    }

    // Prepare data for the store action
    const expenseData = {
      title: formState.title.trim(),
      amount: numericAmount,
      date: formState.date.toISOString().split("T")[0],
      category: formState.category,
      ...(formState.caption.trim()
        ? { caption: formState.caption.trim() }
        : {}),
      ...(groupIdForExpense ? { groupId: groupIdForExpense } : {}),
      ...(paidById ? { paidBy: paidById } : {}),
      // Split between only makes sense for formal group expenses where explicitly selected
      ...(formState.selectedGroup && formState.selectedParticipants.length > 0
        ? { splitBetween: formState.selectedParticipants.map((p) => p.id) }
        : {}),
    };

    // The check for paidById on personal expenses is removed.
    // If currentUserParticipant was null, paidById will be undefined,
    // and the expense will be added without a payer, which is now allowed.

    // Call the appropriate store action
    if (isEditing && editingExpense) {
      updateExpenseToStore({
        ...expenseData,
        id: editingExpense.id, // Include ID for update
      });
    } else {
      addExpenseToStore(expenseData);
    }

    navigation.goBack(); // Navigate back after successful submission
  };

  return {
    formState,
    setFormState, // Expose setFormState directly if needed for complex updates (like modals)
    handleUpdateFormState,
    handleRemoveParticipant,
    onChangeDate,
    handleSubmit,
    isEditing,
    // Expose necessary data for modals/pickers if not handled by components
    groups,
    participants,
  };
};
