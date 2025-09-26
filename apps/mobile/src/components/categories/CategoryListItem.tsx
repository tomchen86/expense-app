import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import Animated, { interpolate } from 'react-native-reanimated';
import { Category } from '../../types';

interface CategoryListItemProps {
  category: Category;
  onEdit: (category: Category) => void;
  onDelete: (categoryId: string) => void;
  canDelete?: boolean;
}

const CategoryListItem: React.FC<CategoryListItemProps> = ({
  category,
  onEdit,
  onDelete,
  canDelete = true,
}) => {
  const renderRightActions = (progress: any, dragX: any) => {
    // Note: react-native-gesture-handler passes Animated values
    // Use Reanimated's interpolate function
    const trans = interpolate(dragX, [-80, 0], [0, 80], 'clamp');

    return (
      <TouchableOpacity
        onPress={() => onDelete(category.id)}
        style={styles.deleteButton}
      >
        <Animated.Text
          style={[
            styles.deleteButtonText,
            {
              transform: [{ translateX: trans }],
            },
          ]}
        >
          Delete
        </Animated.Text>
      </TouchableOpacity>
    );
  };

  const renderContent = () => (
    <TouchableOpacity
      style={styles.itemContainer}
      onPress={() => onEdit(category)}
      activeOpacity={0.7}
    >
      <View style={[styles.colorDot, { backgroundColor: category.color }]} />
      <Text style={styles.itemName}>{category.name}</Text>
      {!canDelete && <Text style={styles.protectedLabel}>Protected</Text>}
    </TouchableOpacity>
  );

  // Special handling for protected categories (like "Other")
  if (!canDelete) {
    return renderContent();
  }

  return (
    <Swipeable renderRightActions={renderRightActions}>
      {renderContent()}
    </Swipeable>
  );
};

const styles = StyleSheet.create({
  itemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  colorDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginRight: 15,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  itemName: {
    fontSize: 16,
    color: '#333',
    flex: 1,
  },
  protectedLabel: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
  },
  deleteButton: {
    backgroundColor: '#FF3B30',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  deleteButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
});

export default CategoryListItem;
