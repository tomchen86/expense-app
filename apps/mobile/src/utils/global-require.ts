// Shim global.require in Metro so Expo's external-require polyfill stops throwing.
export {};

declare global {
  // __r is Metro's internal module loader.
  // eslint-disable-next-line @typescript-eslint/ban-types
  var __r: ((moduleId: string | number) => unknown) | undefined;
  // eslint-disable-next-line @typescript-eslint/ban-types
  var require: ((moduleId: string | number) => unknown) | undefined;
}

if (typeof global.require === 'undefined' && typeof global.__r === 'function') {
  const metroRequire = global.__r;
  const shim = (moduleId: string | number) => metroRequire(moduleId);

  // Attach basic shape so callers can introspect without crashing.
  Object.assign(shim, { main: undefined, extensions: Object.create(null) });

  Object.defineProperty(global, 'require', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: shim,
  });
}
