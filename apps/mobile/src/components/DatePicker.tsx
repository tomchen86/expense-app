import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ViewStyle,
  TextStyle,
} from "react-native";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";

interface DatePickerProps {
  label: string;
  date: Date;
  onChange: (event: DateTimePickerEvent, selectedDate?: Date) => void;
  containerStyle?: ViewStyle;
  labelStyle?: TextStyle;
  valueStyle?: TextStyle;
  // Add other DateTimePicker props if needed (e.g., minimumDate, maximumDate)
}

const DatePicker: React.FC<DatePickerProps> = ({
  label,
  date,
  onChange,
  containerStyle,
  labelStyle,
  valueStyle,
  ...rest // Pass down other DateTimePicker props
}) => {
  const [showPicker, setShowPicker] = useState(false);

  const handleDateChange = (
    event: DateTimePickerEvent,
    selectedDate?: Date
  ) => {
    // On Android, the picker closes automatically. On iOS, we need to hide it manually.
    if (Platform.OS === "android") {
      setShowPicker(false);
    }
    // Propagate the change up, regardless of whether a date was selected (event type 'dismissed')
    onChange(event, selectedDate || date); // Pass current date if dismissed
  };

  // On iOS, provide a button to confirm the date selection within the modal
  const renderIOSConfirmationButton = () => (
    <TouchableOpacity
      style={styles.iosDoneButton}
      onPress={() => setShowPicker(false)}
    >
      <Text style={styles.iosDoneButtonText}>Done</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, containerStyle]}>
      <Text style={[styles.label, labelStyle]}>{label}</Text>
      <TouchableOpacity
        onPress={() => setShowPicker(true)}
        style={styles.touchable}
      >
        <Text style={[styles.valueText, valueStyle]}>
          {date.toLocaleDateString()} {/* Display formatted date */}
        </Text>
      </TouchableOpacity>

      {showPicker && (
        <>
          {/* iOS requires a confirmation button, often placed above or below */}
          {Platform.OS === "ios" && renderIOSConfirmationButton()}
          <DateTimePicker
            testID="dateTimePicker"
            value={date}
            mode={"date"}
            display={Platform.OS === "ios" ? "spinner" : "default"} // 'spinner' looks better on iOS modal
            onChange={handleDateChange}
            {...rest} // Apply remaining props
          />
        </>
      )}
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
    paddingVertical: 10,
    backgroundColor: "#fff",
    minHeight: 40,
    justifyContent: "center",
  },
  valueText: {
    fontSize: 16,
    color: "#000",
  },
  // Styles specific to iOS confirmation button (adjust as needed)
  iosDoneButton: {
    alignSelf: "flex-end", // Position button to the right
    padding: 10,
    backgroundColor: "#007bff",
    borderRadius: 5,
    marginVertical: 5, // Add some spacing
  },
  iosDoneButtonText: {
    color: "#fff",
    fontWeight: "500",
  },
});

export default DatePicker;
