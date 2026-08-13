import { createUuid } from '../ids';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('durable UUID generation', () => {
  it('creates a UUID v4 from a cryptographic source', () => {
    expect(createUuid()).toMatch(UUID_V4);
  });

  it('uses the Expo native provider when a Web Crypto global is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });

    try {
      expect(createUuid()).toMatch(UUID_V4);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'crypto', descriptor);
      }
    }
  });
});
