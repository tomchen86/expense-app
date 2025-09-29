import React, { useState, useMemo as _useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useExpenseStore } from '../../src/store/expenseStore';
import {
  ExpenseGroup,
  Participant as _Participant,
  Expense,
} from '../../src/types';

import GroupListItem from '../../src/components/GroupListItem';
import TextInputModal from '../../src/components/TextInputModal';
import FloatingActionButton from '../../src/components/FloatingActionButton';
import { calculateGroupTotal } from '../../src/utils/groupCalculations';

const HistoryScreen = () => {
  const groups = useExpenseStore((state) => state.groups);
  const expenses = useExpenseStore((state) => state.expenses);
  const userSettings = useExpenseStore((state) => state.userSettings);

  const addGroup = useExpenseStore((state) => state.addGroup);
  const addParticipant = useExpenseStore((state) => state.addParticipant);
  const addParticipantToGroup = useExpenseStore(
    (state) => state.addParticipantToGroup,
  );
  const removeParticipantFromGroup = useExpenseStore(
    (state) => state.removeParticipantFromGroup,
  );
  const deleteGroup = useExpenseStore((state) => state.deleteGroup);

  const [isNewGroupModalVisible, setIsNewGroupModalVisible] = useState(false);
  const [isAddParticipantModalVisible, setIsAddParticipantModalVisible] =
    useState(false);
  const [groupToAddParticipantTo, setGroupToAddParticipantTo] =
    useState<ExpenseGroup | null>(null);

  const handleDeleteGroup = (groupId: string) => {
    Alert.alert(
      'Delete Group',
      'Are you sure you want to delete this group? This will not delete the expenses.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteGroup(groupId),
        },
      ],
    );
  };

  const handleRemoveParticipant = (groupId: string, participantId: string) => {
    Alert.alert(
      'Remove Participant',
      'Are you sure you want to remove this participant from the group?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeParticipantFromGroup(groupId, participantId),
        },
      ],
    );
  };

  const openNewGroupModal = () => {
    if (!userSettings?.name?.trim()) {
      Alert.alert(
        'Username Required',
        'Please set your username in Settings before creating a group.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Go to Settings',
            onPress: () => router.push('/settings'),
          },
        ],
      );
      return;
    }
    setIsNewGroupModalVisible(true);
  };

  const handleNewGroupSubmit = (groupName: string) => {
    addGroup(groupName);
  };

  const openAddParticipantModal = (group: ExpenseGroup) => {
    setGroupToAddParticipantTo(group);
    setIsAddParticipantModalVisible(true);
  };

  const handleAddParticipantSubmit = (participantName: string) => {
    if (groupToAddParticipantTo) {
      const participantId = addParticipant(participantName);
      addParticipantToGroup(groupToAddParticipantTo.id, participantId);
    }
    setGroupToAddParticipantTo(null);
  };

  const handleGroupPress = (groupId: string) => {
    router.push({
      pathname: '/group-detail',
      params: { groupId },
    });
  };

  const renderGroupListItem = ({ item: group }: { item: ExpenseGroup }) => {
    const totalAmount = calculateGroupTotal(expenses, group.id);

    return (
      <GroupListItem
        group={group}
        totalAmount={totalAmount}
        onDeleteGroup={handleDeleteGroup}
        onRemoveParticipant={handleRemoveParticipant}
        onAddParticipant={openAddParticipantModal}
        onPress={handleGroupPress}
      />
    );
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.createGroupButton}
        onPress={openNewGroupModal}
      >
        <Text style={styles.createGroupButtonText}>Create New Group</Text>
      </TouchableOpacity>

      <FlatList
        data={groups}
        renderItem={renderGroupListItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.groupsList}
        ListEmptyComponent={
          <Text style={styles.emptyListText}>No groups yet. Create one!</Text>
        }
      />

      <TextInputModal
        visible={isNewGroupModalVisible}
        title='Create New Group'
        placeholder='Enter group name'
        submitButtonText='Create'
        onSubmit={handleNewGroupSubmit}
        onClose={() => setIsNewGroupModalVisible(false)}
      />

      <TextInputModal
        visible={isAddParticipantModalVisible}
        title={`Add Participant to ${groupToAddParticipantTo?.name || ''}`}
        placeholder='Enter participant name'
        submitButtonText='Add'
        onSubmit={handleAddParticipantSubmit}
        onClose={() => {
          setIsAddParticipantModalVisible(false);
          setGroupToAddParticipantTo(null);
        }}
      />
      <FloatingActionButton />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  createGroupButton: {
    backgroundColor: '#007bff',
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.23,
    shadowRadius: 2.62,
    elevation: 4,
  },
  createGroupButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  groupsList: {
    paddingBottom: 20,
  },
  emptyListText: {
    textAlign: 'center',
    marginTop: 50,
    fontSize: 16,
    color: '#6c757d',
  },
});

export default HistoryScreen;
