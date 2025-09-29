export const router = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  setParams: jest.fn(),
  dismiss: jest.fn(),
};

export const useRouter = () => router;
export const useLocalSearchParams = jest.fn(() => ({}));
export const useGlobalSearchParams = jest.fn(() => ({}));
export const usePathname = jest.fn(() => '/');
export const useSegments = jest.fn(() => []);
export const useNavigationContainerRef = jest.fn();

export const Stack = {
  Screen: ({ children }: { children?: React.ReactNode }) => children || null,
};

export const Tabs = {
  Screen: ({ children }: { children?: React.ReactNode }) => children || null,
};

export const Link = ({ children }: { children?: React.ReactNode }) =>
  children || null;

export const Redirect = () => null;
export const Slot = ({ children }: { children?: React.ReactNode }) =>
  children || null;

export default {
  router,
  useRouter,
  useLocalSearchParams,
  useGlobalSearchParams,
  usePathname,
  useSegments,
  useNavigationContainerRef,
  Stack,
  Tabs,
  Link,
  Redirect,
  Slot,
};
