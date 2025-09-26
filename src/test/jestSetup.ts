/* eslint-disable @typescript-eslint/no-explicit-any */

// Suppress expected DAP protocol violation warnings in tests
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  const message = args[0];
  if (typeof message === 'string' && message.includes('attempt to send more than one response')) {
    return; // Suppress this specific error in tests
  }
  originalConsoleError.apply(console, args);
};

// Export empty object to make this a module
export {};