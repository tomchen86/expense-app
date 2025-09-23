import React, { createRef, forwardRef, useImperativeHandle } from "react";
import { Alert } from "react-native";
import TestRenderer, { act } from "react-test-renderer";
import { DEFAULT_CATEGORIES } from "../../constants/expenses";
import { useExpenseStore as useComposedExpenseStore } from "../../store/expenseStore";
import { useCategoryStore } from "../../store/features/categoryStore";
import { useCategoryManager } from "../useCategoryManager";

jest.mock("react-native", () => ({
  Alert: {
    alert: jest.fn(),
  },
}));

const HookHarness = forwardRef((_, ref) => {
  const hookValue = useCategoryManager();
  useImperativeHandle(ref, () => hookValue, [hookValue]);
  return null;
});
HookHarness.displayName = "HookHarness";

const resetCategoryStores = () => {
  useCategoryStore.setState({
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
  });
  useComposedExpenseStore.setState((state) => ({
    ...state,
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
  }));
};

describe("useCategoryManager", () => {
  beforeEach(() => {
    resetCategoryStores();
    (Alert.alert as jest.Mock).mockClear();
  });

  it("opens and closes modals for create vs edit flows", () => {
    const ref = createRef<ReturnType<typeof useCategoryManager>>();

    act(() => {
      TestRenderer.create(<HookHarness ref={ref} />);
    });

    expect(ref.current?.modalVisible).toBe(false);

    act(() => {
      ref.current?.openAddModal();
    });
    expect(ref.current?.modalVisible).toBe(true);
    expect(ref.current?.isEditing).toBeNull();

    const firstCategory = ref.current!.categories[0];

    act(() => {
      ref.current?.openEditModal(firstCategory);
    });
    expect(ref.current?.modalVisible).toBe(true);
    expect(ref.current?.isEditing).toEqual(firstCategory);

    act(() => {
      ref.current?.closeModal();
    });
    expect(ref.current?.modalVisible).toBe(false);
    expect(ref.current?.isEditing).toBeNull();
  });

  it("adds new categories when name unique", () => {
    const ref = createRef<ReturnType<typeof useCategoryManager>>();

    act(() => {
      TestRenderer.create(<HookHarness ref={ref} />);
    });

    act(() => {
      ref.current?.openAddModal();
      ref.current?.saveCategory("Fitness", "#00FF00");
    });

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(
      useCategoryStore.getState().getCategoryByName("Fitness")?.color,
    ).toBe("#00FF00");
  });

  it("rejects duplicate category names", () => {
    const ref = createRef<ReturnType<typeof useCategoryManager>>();

    act(() => {
      TestRenderer.create(<HookHarness ref={ref} />);
    });

    const existing = ref.current!.categories[0];

    act(() => {
      ref.current?.openAddModal();
      ref.current?.saveCategory(existing.name, "#123456");
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      "Error",
      "A category with this name already exists.",
    );
  });

  it("updates existing categories and prevents deleting 'Other'", () => {
    const ref = createRef<ReturnType<typeof useCategoryManager>>();

    act(() => {
      TestRenderer.create(<HookHarness ref={ref} />);
    });

    const categoryToEdit = ref.current!.categories[1];

    act(() => {
      ref.current?.openEditModal(categoryToEdit);
      ref.current?.saveCategory("Updated Name", "#654321");
    });

    expect(
      useCategoryStore.getState().getCategoryByName("Updated Name")?.color,
    ).toBe("#654321");

    act(() => {
      ref.current?.deleteCategory(
        ref.current!.categories.find((cat) => cat.name === "Other")!.id,
      );
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      "Error",
      "The 'Other' category cannot be deleted.",
    );
  });
});
