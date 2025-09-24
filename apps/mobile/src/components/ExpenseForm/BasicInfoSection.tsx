import React from 'react';
import { ExpenseCategory } from '../../types';
import FormInput from '../FormInput';
import SelectInput from '../SelectInput';
import DatePicker from '../DatePicker';
import { DateTimePickerEvent } from '@react-native-community/datetimepicker';

interface BasicInfoSectionProps {
  title: string;
  amount: string;
  category: ExpenseCategory;
  caption: string;
  date: Date;
  onTitleChange: (value: string) => void;
  onAmountChange: (value: string) => void;
  onCategoryPress: () => void;
  onCaptionChange: (value: string) => void;
  onDateChange: (event: DateTimePickerEvent, selectedDate?: Date) => void;
}

export const BasicInfoSection: React.FC<BasicInfoSectionProps> = ({
  title,
  amount,
  category,
  caption,
  date,
  onTitleChange,
  onAmountChange,
  onCategoryPress,
  onCaptionChange,
  onDateChange,
}) => {
  return (
    <>
      <FormInput
        label='Title:'
        value={title}
        onChangeText={onTitleChange}
        placeholder='Enter expense title'
      />

      <FormInput
        label='Amount:'
        value={amount}
        onChangeText={onAmountChange}
        placeholder='Enter amount'
        keyboardType='numeric'
      />

      <SelectInput
        label='Category:'
        selectedValue={category}
        onPress={onCategoryPress}
      />

      <FormInput
        label='Caption (optional):'
        value={caption}
        onChangeText={onCaptionChange}
        placeholder='Add a note about this expense'
        multiline
        numberOfLines={3}
      />

      <DatePicker label='Date:' date={date} onChange={onDateChange} />
    </>
  );
};
