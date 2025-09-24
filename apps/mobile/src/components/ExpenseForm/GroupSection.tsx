import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Participant, ExpenseGroup } from '../../types';
import SelectInput from '../SelectInput';
import ParticipantTag from '../ParticipantTag';

interface GroupSectionProps {
  selectedGroup: ExpenseGroup | null;
  paidByParticipant: Participant | null;
  selectedParticipants: Participant[];
  onGroupPress: () => void;
  onPaidByPress: () => void;
  onSplitPress: () => void;
  onRemoveParticipant: (participantId: string) => void;
}

export const GroupSection: React.FC<GroupSectionProps> = ({
  selectedGroup,
  paidByParticipant,
  selectedParticipants,
  onGroupPress,
  onPaidByPress,
  onSplitPress,
  onRemoveParticipant,
}) => {
  return (
    <>
      <SelectInput
        label='Group (optional):'
        selectedValue={selectedGroup?.name}
        placeholder='Select Group'
        onPress={onGroupPress}
      />

      {selectedGroup && (
        <>
          <SelectInput
            label='Paid By:'
            selectedValue={paidByParticipant?.name}
            placeholder='Select Payer'
            onPress={onPaidByPress}
          />

          <Text style={styles.label}>Split Between:</Text>
          <View style={styles.selectedParticipantsContainer}>
            {selectedParticipants.map((participant) => (
              <ParticipantTag
                key={participant.id}
                participantName={participant.name}
                onRemove={() => onRemoveParticipant(participant.id)}
              />
            ))}
            <SelectInput
              label=''
              selectedValue='+ Add'
              onPress={onSplitPress}
              containerStyle={styles.addParticipantButtonContainer}
              valueStyle={styles.addParticipantButtonText}
            />
          </View>
        </>
      )}
    </>
  );
};

const styles = StyleSheet.create({
  label: {
    fontSize: 16,
    marginBottom: 5,
    color: '#333',
    fontWeight: '500',
  },
  selectedParticipantsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: 15,
  },
  addParticipantButtonContainer: {
    marginBottom: 0,
    borderWidth: 0,
    paddingVertical: 0,
  },
  addParticipantButtonText: {
    color: '#007bff',
    fontSize: 16,
    padding: 8,
  },
});
