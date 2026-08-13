import { useState, useEffect, useMemo } from 'react';
import { Platform as _Platform, Alert } from 'react-native';
import { router } from 'expo-router';
import { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useExpenseStore } from '../store/expenseStore';
import { flushExpensePersistence } from '../store/features/expenseStore';
import {
  Expense,
  Participant,
  ExpenseGroup,
  ExpenseCategory,
  Category as _Category,
} from '../types'; // Added Category for type safety if needed
import {
  allocateEqualShares,
  formatLocalCalendarDate,
  minorUnitsToDecimalString,
  parseDecimalToMinorUnits,
  parseLocalCalendarDate,
} from '../utils/money';
import {
  getExpenseAmountMinor,
  getExpenseCurrency,
  getExpensePayments,
  getExpenseShares,
  getExpenseSpaceId,
  getExpenseSpaceKind,
} from '../utils/expenseDomain';

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
  initialSpaceId?: string;
}

export const useExpenseForm = ({
  editingExpense,
  initialSpaceId,
}: UseExpenseFormProps) => {
  // Get data and actions from the Zustand store
  const addExpenseToStore = useExpenseStore((state) => state.addExpense);
  const updateExpenseToStore = useExpenseStore((state) => state.updateExpense);
  const groups = useExpenseStore((state) => state.groups);
  const participants = useExpenseStore((state) => state.participants);
  const categories = useExpenseStore((state) => state.categories);
  const userSettings = useExpenseStore((state) => state.userSettings);
  const internalUserId = useExpenseStore((state) => state.internalUserId); // Get internalUserId
  const user = useExpenseStore((state) => state.user);
  const settings = useExpenseStore((state) => state.settings);
  const personalSpaceId = useExpenseStore((state) => state.personalSpaceId);
  const personalParticipantId = useExpenseStore(
    (state) => state.personalParticipantId,
  );

  const isEditing = !!editingExpense;

  // Find the current user's participant entry
  const _currentUserParticipant = useMemo(() => {
    return userSettings?.name
      ? participants.find((p) => p.name === userSettings.name)
      : null;
  }, [userSettings, participants]);

  // Initialize state with default values
  const [formState, setFormState] = useState<FormState>({
    title: '',
    amount: '',
    date: new Date(),
    caption: '',
    category: categories[0]?.name ?? 'Other', // Use first category from store
    selectedGroup: null,
    paidByParticipant: null,
    selectedParticipants: [],
  });

  // Initialize form state from editingExpense when it changes
  useEffect(() => {
    if (!editingExpense) {
      const initialGroup = initialSpaceId
        ? (groups.find((group) => group.id === initialSpaceId) ?? null)
        : null;
      // Reset form if editingExpense becomes null/undefined (e.g., navigating back)
      setFormState({
        title: '',
        amount: '',
        date: new Date(),
        caption: '',
        category: categories[0]?.name ?? 'Other', // Use first category from store
        selectedGroup: initialGroup,
        paidByParticipant: null,
        selectedParticipants: [],
      });
      return;
    }

    const expenseSpaceId = getExpenseSpaceId(editingExpense);
    const group =
      expenseSpaceId && getExpenseSpaceKind(editingExpense) !== 'personal'
        ? (groups.find((g) => g.id === expenseSpaceId) ?? null)
        : null;
    const paymentParticipantId =
      getExpensePayments(editingExpense)[0]?.participantId;
    const paidBy = paymentParticipantId
      ? (participants.find((p) => p.id === paymentParticipantId) ?? null)
      : null;
    const shareParticipantIds = new Set(
      getExpenseShares(editingExpense).map((share) => share.participantId),
    );
    const splitBetween = participants.filter((participant) =>
      shareParticipantIds.has(participant.id),
    );
    const expenseCurrency = getExpenseCurrency(editingExpense);

    setFormState({
      title: editingExpense.title,
      amount: minorUnitsToDecimalString(
        getExpenseAmountMinor(editingExpense),
        expenseCurrency,
      ),
      date: parseLocalCalendarDate(editingExpense.date) ?? new Date(),
      caption: editingExpense.caption ?? '',
      category: editingExpense.category,
      selectedGroup: group,
      paidByParticipant: paidBy,
      selectedParticipants: splitBetween,
    });
  }, [editingExpense, groups, participants, categories, initialSpaceId]);

  // Generic handler to update any form field
  const handleUpdateFormState = (field: keyof FormState, value: any) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  // Handler to remove a participant from the split list
  const handleRemoveParticipant = (participantId: string) => {
    setFormState((prev) => ({
      ...prev,
      selectedParticipants: prev.selectedParticipants.filter(
        (p) => p.id !== participantId,
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
  const handleSubmit = async () => {
    // --- Validation ---
    if (
      !formState.title ||
      !formState.amount ||
      !formState.date ||
      !formState.category
    ) {
      Alert.alert('Validation Error', 'Please fill all required fields.');
      return;
    }

    const currency = settings.currency.toUpperCase();
    const amountMinor = parseDecimalToMinorUnits(formState.amount, currency);
    if (amountMinor === null) {
      Alert.alert(
        'Validation Error',
        'Amount must be a positive value with valid currency precision.',
      );
      return;
    }

    if (
      formState.selectedGroup &&
      (!formState.paidByParticipant ||
        formState.selectedParticipants.length === 0)
    ) {
      Alert.alert(
        'Validation Error',
        'When adding to a group, please select who paid and who to split with.',
      );
      return;
    }
    // --- End Validation ---

    const currentUserId = user?.id ?? internalUserId;
    if (!currentUserId || !personalParticipantId) {
      Alert.alert('Validation Error', 'A local user identity is required.');
      return;
    }

    const isSharedExpense = !!formState.selectedGroup;
    const spaceId = formState.selectedGroup?.id ?? personalSpaceId;
    const payerId = isSharedExpense
      ? formState.paidByParticipant!.id
      : personalParticipantId;
    const shares = isSharedExpense
      ? allocateEqualShares(
          amountMinor,
          formState.selectedParticipants.map((participant) => participant.id),
        )
      : [{ participantId: personalParticipantId, amountMinor }];
    const selectedCategory = categories.find(
      (category) => category.name === formState.category,
    );

    // Prepare data for the store action
    const expenseData = {
      title: formState.title.trim(),
      amountMinor,
      currency,
      date: formatLocalCalendarDate(formState.date),
      category: formState.category,
      ...(selectedCategory ? { categoryId: selectedCategory.id } : {}),
      spaceId,
      spaceKind: isSharedExpense ? ('shared' as const) : ('personal' as const),
      payments: [{ participantId: payerId, amountMinor }],
      shares,
      ...(formState.caption.trim()
        ? { caption: formState.caption.trim() }
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

    try {
      await flushExpensePersistence();
      router.back();
    } catch {
      Alert.alert(
        'Storage Error',
        'The expense could not be saved to this device. Please try again.',
      );
    }
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
    categories,
  };
};
