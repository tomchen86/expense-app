import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ExpenseGroup, Participant as _Participant } from '../types';

interface GroupListItemProps {
  group: ExpenseGroup;
  totalAmount: number; // Pass calculated total as prop
  onDeleteGroup: (groupId: string) => void;
  onRemoveParticipant: (groupId: string, participantId: string) => void;
  onAddParticipant: (group: ExpenseGroup) => void;
  onPress: (groupId: string) => void; // Add onPress prop for navigation
}

const GroupListItem: React.FC<GroupListItemProps> = ({
  group,
  totalAmount,
  onDeleteGroup,
  onRemoveParticipant,
  onAddParticipant,
  onPress, // Destructure onPress
}) => {
  return (
    <TouchableOpacity
      onPress={() => onPress(group.id)}
      style={styles.groupCard}
    >
      {/* Group Header */}
      <View style={styles.groupHeader}>
        <Text style={styles.groupName}>{group.name}</Text>
        <TouchableOpacity
          onPress={() => onDeleteGroup(group.id)}
          style={styles.deleteButton}
        >
          <Text style={styles.deleteButtonText}>Delete</Text>
        </TouchableOpacity>
      </View>

      {/* Group Total */}
      <Text style={styles.groupTotal}>Total: ${totalAmount.toFixed(2)}</Text>

      {/* Participants Section */}
      <Text style={styles.participantsLabel}>Participants:</Text>
      <View style={styles.participantsList}>
        {group.participants.map((participant) => (
          <View key={participant.id} style={styles.participantItem}>
            <Text style={styles.participantName}>{participant.name}</Text>
            <TouchableOpacity
              onPress={() => onRemoveParticipant(group.id, participant.id)}
              style={styles.removeParticipantButton}
            >
              <Text style={styles.removeParticipantText}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
        {/* Add Participant Button */}
        <TouchableOpacity
          style={styles.addParticipantButton}
          onPress={() => onAddParticipant(group)}
        >
          <Text style={styles.addParticipantText}>+ Add Participant</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
};

// Styles copied and adapted from HistoryScreen.tsx
const styles = StyleSheet.create({
  groupCard: {
    backgroundColor: '#ffffff',
    padding: 15,
    borderRadius: 8,
    marginBottom: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
  },
  groupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  groupName: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  deleteButton: {
    backgroundColor: '#dc3545',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  deleteButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
  groupTotal: {
    fontSize: 16,
    color: '#28a745',
    marginBottom: 10,
  },
  participantsLabel: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 10,
  },
  participantsList: {
    marginLeft: 10,
  },
  participantItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 5,
  },
  participantName: {
    fontSize: 16,
  },
  removeParticipantButton: {
    padding: 5,
  },
  removeParticipantText: {
    color: '#dc3545',
    fontSize: 20,
    fontWeight: 'bold',
  },
  addParticipantButton: {
    marginTop: 10,
  },
  addParticipantText: {
    color: '#007bff',
    fontSize: 16,
  },
});

export default GroupListItem;
