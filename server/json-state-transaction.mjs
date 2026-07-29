import { AsyncLocalStorage } from "node:async_hooks";

export function createJsonStateTransactionBoundary({
  enabled = () => true,
} = {}) {
  if (typeof enabled !== "function") {
    throw new TypeError("JSON state transaction boundary requires enabled()");
  }

  let queue = Promise.resolve();
  const context = new AsyncLocalStorage();
  let activeTransaction = null;

  function run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("JSON state transaction requires an operation");
    }
    if (!enabled()) return operation();
    if (context.getStore() === activeTransaction) return operation();
    const flight = queue
      .catch(() => {})
      .then(async () => {
        const transaction = {};
        activeTransaction = transaction;
        try {
          return await context.run(transaction, operation);
        } finally {
          if (activeTransaction === transaction) activeTransaction = null;
        }
      });
    queue = flight.catch(() => {});
    return flight;
  }

  return Object.freeze({ run });
}
