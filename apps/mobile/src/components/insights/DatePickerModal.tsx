import React from "react";
import { View, Text, StyleSheet, Modal, Button } from "react-native";
import { Picker } from "@react-native-picker/picker";

interface DatePickerModalProps {
  visible: boolean;
  onClose: () => void;
  aggregation: "month" | "year";
  selectedYear: number;
  selectedMonth: number;
  onYearChange: (year: number) => void;
  onMonthChange: (month: number) => void;
  availableYears: number[];
  monthNames: string[];
}

const DatePickerModal: React.FC<DatePickerModalProps> = ({
  visible,
  onClose,
  aggregation,
  selectedYear,
  selectedMonth,
  onYearChange,
  onMonthChange,
  availableYears,
  monthNames,
}) => {
  return (
    <Modal
      transparent={true}
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Select Period</Text>

          <View style={styles.dateSelectorsContainer}>
            {aggregation === "month" && (
              <View style={styles.pickerContainer}>
                <Text style={styles.dateSelectorLabel}>Month:</Text>
                <Picker
                  selectedValue={selectedMonth}
                  style={styles.picker}
                  onValueChange={onMonthChange}
                  itemStyle={styles.pickerItem}
                >
                  {monthNames.map((monthName, index) => (
                    <Picker.Item
                      key={index}
                      label={monthName}
                      value={index}
                    />
                  ))}
                </Picker>
              </View>
            )}

            <View style={styles.pickerContainer}>
              <Text style={styles.dateSelectorLabel}>Year:</Text>
              <Picker
                selectedValue={selectedYear}
                style={styles.picker}
                onValueChange={onYearChange}
                itemStyle={styles.pickerItem}
              >
                {availableYears.map((year) => (
                  <Picker.Item
                    key={year}
                    label={year.toString()}
                    value={year}
                  />
                ))}
              </Picker>
            </View>
          </View>

          <Button title="Done" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  modalContent: {
    backgroundColor: "white",
    padding: 20,
    borderRadius: 10,
    width: "80%",
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 15,
  },
  dateSelectorsContainer: {
    flexDirection: "column",
    marginBottom: 20,
  },
  pickerContainer: {
    marginBottom: 10,
  },
  dateSelectorLabel: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 5,
    color: "#333",
  },
  picker: {
    height: 150,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 5,
  },
  pickerItem: {
    fontSize: 16,
    height: 150,
  },
});

export default DatePickerModal;