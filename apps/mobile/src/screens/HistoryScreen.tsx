import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
} from "react-native";
import { useNavigation } from "@react-navigation/native"; // Import useNavigation
import { StackNavigationProp } from "@react-navigation/stack"; // Import StackNavigationProp
import { useExpenseStore } from "../store/expenseStore";
import { ExpenseGroup, Participant, Expense } from "../types"; // Add Expense type

// Import reusable components and utils
import GroupListItem from "../components/GroupListItem";
import TextInputModal from "../components/TextInputModal";
import FloatingActionButton from "../components/FloatingActionButton"; // Import FAB
import { calculateGroupTotal } from "../utils/groupCalculations";

// Define navigation param list (ideally move to central types)
type RootStackParamList = {
  Home: undefined;
  AddExpense: { expense?: Expense } | undefined;
  History: undefined;
  GroupDetail: { groupId: string };
};

const HistoryScreen = () => {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>(); // Initialize navigation
  // --- State from Zustand Store ---
  const groups = useExpenseStore((state) => state.groups);
  const expenses = useExpenseStore((state) => state.expenses);
  const userSettings = useExpenseStore((state) => state.userSettings); // Get userSettings
  // Participants might not be directly needed here anymore if GroupListItem handles display
  // const participants = useExpenseStore((state) => state.participants);

  // --- Actions from Zustand Store ---
  const addGroup = useExpenseStore((state) => state.addGroup);
  const addParticipant = useExpenseStore((state) => state.addParticipant);
  const addParticipantToGroup = useExpenseStore(
    (state) => state.addParticipantToGroup,
  );
  const removeParticipantFromGroup = useExpenseStore(
    (state) => state.removeParticipantFromGroup,
  );
  const deleteGroup = useExpenseStore((state) => state.deleteGroup);

  // --- Modal State ---
  const [isNewGroupModalVisible, setIsNewGroupModalVisible] = useState(false);
  const [isAddParticipantModalVisible, setIsAddParticipantModalVisible] =
    useState(false);
  const [groupToAddParticipantTo, setGroupToAddParticipantTo] =
    useState<ExpenseGroup | null>(null);

  // --- Handlers ---

  // Delete Group Confirmation
  const handleDeleteGroup = (groupId: string) => {
    Alert.alert(
      "Delete Group",
      "Are you sure you want to delete this group? This will not delete the expenses.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteGroup(groupId),
        },
      ],
    );
  };

  // Remove Participant Confirmation
  const handleRemoveParticipant = (groupId: string, participantId: string) => {
    Alert.alert(
      "Remove Participant",
      "Are you sure you want to remove this participant from the group?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => removeParticipantFromGroup(groupId, participantId),
        },
      ],
    );
  };

  // Open/Submit New Group Modal
  const openNewGroupModal = () => {
    if (!userSettings?.name?.trim()) {
      Alert.alert(
        "Username Required",
        "Please set your username in Settings before creating a group.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Go to Settings",
            onPress: () => navigation.navigate("Settings" as any), // Navigate to Settings tab/screen
          },
        ],
      );
      return;
    }
    setIsNewGroupModalVisible(true);
  };

  const handleNewGroupSubmit = (groupName: string) => {
    addGroup(groupName);
    // Modal closes itself on submit via TextInputModal's internal logic
  };

  // Open/Submit Add Participant Modal
  const openAddParticipantModal = (group: ExpenseGroup) => {
    setGroupToAddParticipantTo(group);
    setIsAddParticipantModalVisible(true);
  };
  const handleAddParticipantSubmit = (participantName: string) => {
    if (groupToAddParticipantTo) {
      const participantId = addParticipant(participantName); // Add globally first
      addParticipantToGroup(groupToAddParticipantTo.id, participantId); // Then add to group
    }
    setGroupToAddParticipantTo(null);
  };

  // Navigate to Group Detail Screen
  const handleGroupPress = (groupId: string) => {
    navigation.navigate("GroupDetail", { groupId });
  };

  // --- Render Logic ---

  const renderGroupListItem = ({ item: group }: { item: ExpenseGroup }) => {
    // Calculate total for this group using the utility function
    const totalAmount = calculateGroupTotal(expenses, group.id);

    return (
      <GroupListItem
        group={group}
        totalAmount={totalAmount}
        onDeleteGroup={handleDeleteGroup}
        onRemoveParticipant={handleRemoveParticipant}
        onAddParticipant={openAddParticipantModal}
        onPress={handleGroupPress} // Pass the navigation handler
      />
    );
  };

  return (
    <View style={styles.container}>
      {/* Button to Create New Group */}
      <TouchableOpacity
        style={styles.createGroupButton}
        onPress={openNewGroupModal}
      >
        <Text style={styles.createGroupButtonText}>Create New Group</Text>
      </TouchableOpacity>

      {/* List of Groups */}
      <FlatList
        data={groups}
        renderItem={renderGroupListItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.groupsList}
        ListEmptyComponent={
          <Text style={styles.emptyListText}>No groups yet. Create one!</Text>
        }
      />

      {/* Reusable Modals */}
      <TextInputModal
        visible={isNewGroupModalVisible}
        title="Create New Group"
        placeholder="Enter group name"
        submitButtonText="Create"
        onSubmit={handleNewGroupSubmit}
        onClose={() => setIsNewGroupModalVisible(false)}
      />

      <TextInputModal
        visible={isAddParticipantModalVisible}
        title={`Add Participant to ${groupToAddParticipantTo?.name || ""}`}
        placeholder="Enter participant name"
        submitButtonText="Add"
        onSubmit={handleAddParticipantSubmit}
        onClose={() => {
          setIsAddParticipantModalVisible(false);
          setGroupToAddParticipantTo(null); // Clear context on close
        }}
      />
      <FloatingActionButton />
    </View>
  );
};

// --- Styles --- (Keep container, button, list styles)
const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: "#f5f5f5",
  },
  createGroupButton: {
    backgroundColor: "#007bff",
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.23,
    shadowRadius: 2.62,
    elevation: 4,
  },
  createGroupButtonText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "bold",
  },
  groupsList: {
    paddingBottom: 20,
  },
  emptyListText: {
    textAlign: "center",
    marginTop: 50,
    fontSize: 16,
    color: "#6c757d",
  },
  // Remove styles that are now handled by GroupListItem or TextInputModal
});

export default HistoryScreen;
