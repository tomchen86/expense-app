import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from "react-native";

interface SelectInputProps {
  label: string;
  selectedValue: string | null | undefined; // Text to display (e.g., category name, group name)
  placeholder?: string;
  onPress: () => void; // Function to open the modal/picker
  containerStyle?: ViewStyle;
  labelStyle?: TextStyle;
  valueStyle?: TextStyle;
}

const SelectInput: React.FC<SelectInputProps> = ({
  label,
  selectedValue,
  placeholder = "Select...",
  onPress,
  containerStyle,
  labelStyle,
  valueStyle,
}) => {
  const displayValue = selectedValue || placeholder;
  const isPlaceholder = !selectedValue;

  return (
    <View style={[styles.container, containerStyle]}>
      <Text style={[styles.label, labelStyle]}>{label}</Text>
      <TouchableOpacity onPress={onPress} style={styles.touchable}>
        <Text
          style={[
            styles.valueText,
            isPlaceholder && styles.placeholderText,
            valueStyle,
          ]}
        >
          {displayValue}
        </Text>
        {/* Optional: Add an icon like a dropdown arrow here */}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: 15,
  },
  label: {
    fontSize: 16,
    marginBottom: 5,
    color: "#333",
    fontWeight: "500",
  },
  touchable: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 5,
    paddingHorizontal: 10,
    paddingVertical: 10, // Adjust padding for touchable area
    backgroundColor: "#fff",
    minHeight: 40, // Consistent height with FormInput
    justifyContent: "center",
  },
  valueText: {
    fontSize: 16,
    color: "#000",
  },
  placeholderText: {
    color: "#999", // Lighter color for placeholder
  },
});

export default SelectInput;
