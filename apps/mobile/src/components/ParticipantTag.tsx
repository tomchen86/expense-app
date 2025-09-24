import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface ParticipantTagProps {
  participantName: string;
  onRemove: () => void;
}

const ParticipantTag: React.FC<ParticipantTagProps> = ({
  participantName,
  onRemove,
}) => {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{participantName}</Text>
      <TouchableOpacity onPress={onRemove} style={styles.removeButton}>
        <Text style={styles.removeButtonText}>×</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e3f2fd', // Light blue background
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16, // Pill shape
    marginRight: 8, // Spacing between tags
    marginBottom: 8, // Spacing for wrapping
  },
  tagText: {
    color: '#1976d2', // Blue text
    marginRight: 6,
    fontSize: 14,
  },
  removeButton: {
    marginLeft: 4,
    padding: 2, // Small padding for touch area
  },
  removeButtonText: {
    color: '#1976d2', // Blue 'x'
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default ParticipantTag;
