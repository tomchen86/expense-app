import React from "react";
import {
  View,
  Text,
  Modal,
  StyleSheet,
  Pressable,
  FlatList,
} from "react-native";
import { Participant, Expense } from "../types"; // Use Participant type
import {
  calculateAllMemberBalancesInGroup,
  MemberBalanceDetails,
} from "../utils/groupCalculations"; // Import the new util

interface GroupBalancesOverlayProps {
  visible: boolean;
  onClose: () => void;
  members: Participant[]; // Use Participant type
  expenses: Expense[]; // Define or import Expense type
  currentUserId: string; // To identify the current user
}

// Removed local calculateMemberBalance function

const GroupBalancesOverlay: React.FC<GroupBalancesOverlayProps> = ({
  visible,
  onClose,
  members,
  expenses,
  currentUserId,
}) => {
  // Calculate all balances once
  const memberBalanceDetails = React.useMemo(() => {
    return calculateAllMemberBalancesInGroup(members, expenses);
  }, [members, expenses]);

  const renderMemberBalance = ({ item }: { item: MemberBalanceDetails }) => {
    const balance = item.netBalance;
    let balanceText = "";
    if (balance > 0) {
      balanceText = `Is Owed $${balance.toFixed(2)}`;
    } else if (balance < 0) {
      balanceText = `Owes $${Math.abs(balance).toFixed(2)}`;
    } else {
      balanceText = "Settled up";
    }

    return (
      <View style={styles.memberItem}>
        <Text style={styles.memberName}>
          {item.memberName}
          {item.memberId === currentUserId ? " (You)" : ""}
        </Text>
        <Text style={styles.memberBalance}>{balanceText}</Text>
        <Text style={styles.balanceDetail}>
          Paid: ${item.totalPaid.toFixed(2)}, Share: $
          {item.totalShare.toFixed(2)}
        </Text>
      </View>
    );
  };

  return (
    <Modal
      animationType="slide"
      transparent={true}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.centeredView}>
        <View style={styles.modalView}>
          <Text style={styles.modalTitle}>Group Member Balances</Text>
          <FlatList
            data={memberBalanceDetails} // Use pre-calculated balances
            renderItem={renderMemberBalance}
            keyExtractor={(item) => item.memberId} // Use memberId from MemberBalanceDetails
            style={styles.list}
          />
          <Pressable
            style={[styles.button, styles.buttonClose]}
            onPress={onClose}
          >
            <Text style={styles.textStyle}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  centeredView: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)", // Semi-transparent background
  },
  modalView: {
    margin: 20,
    backgroundColor: "white",
    borderRadius: 20,
    padding: 35,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
    width: "90%", // Occupy approx half screen, adjust as needed
    maxHeight: "80%",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 15,
    textAlign: "center",
  },
  list: {
    width: "100%",
  },
  memberItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    width: "100%",
  },
  memberName: {
    fontSize: 16,
    fontWeight: "bold",
  },
  memberBalance: {
    fontSize: 14,
    color: "gray",
  },
  balanceDetail: {
    fontSize: 12,
    color: "darkgray",
    fontStyle: "italic",
  },
  button: {
    borderRadius: 10,
    padding: 10,
    elevation: 2,
    marginTop: 15,
  },
  buttonClose: {
    backgroundColor: "#2196F3",
  },
  textStyle: {
    color: "white",
    fontWeight: "bold",
    textAlign: "center",
  },
});

export default GroupBalancesOverlay;
