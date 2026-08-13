import { useEffect, useState } from 'react';
import { useCategoryStore } from './features/categoryStore';
import { useExpenseStore } from './features/expenseStore';
import { useGroupStore } from './features/groupStore';
import { useParticipantStore } from './features/participantStore';
import { useUserStore } from './features/userStore';

const persistenceApis = [
  useCategoryStore.persist,
  useExpenseStore.persist,
  useGroupStore.persist,
  useParticipantStore.persist,
  useUserStore.persist,
];

export const areMobileStoresHydrated = (): boolean =>
  persistenceApis.every((api) => api.hasHydrated());

export const useMobileStoresHydrated = (): boolean => {
  const [hydrated, setHydrated] = useState(areMobileStoresHydrated);

  useEffect(() => {
    const updateHydrationState = () => {
      setHydrated(areMobileStoresHydrated());
    };
    const unsubscribers = persistenceApis.map((api) =>
      api.onFinishHydration(updateHydrationState),
    );

    persistenceApis.forEach((api) => {
      if (!api.hasHydrated()) {
        void api.rehydrate();
      }
    });
    updateHydrationState();

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  return hydrated;
};
