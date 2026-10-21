import { DatabaseSync } from 'node:sqlite';

import { installAgentStorageKv } from './env.mjs';

export function makeSqlAgentStorage(seed = []) {
  const values = new Map(seed);
  const writes = [];
  const database = new DatabaseSync(':memory:');
  let transactionDepth = 0;
  const result = (rows = [], rowsWritten = 0) => ({
    toArray: () => rows,
    rowsRead: rows.length,
    rowsWritten,
    [Symbol.iterator]: function* iterator() {
      yield* rows;
    },
  });
  const storage = {
    values,
    writes,
    database,
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
      writes.push(['put', key, value]);
    },
    async delete(key) {
      values.delete(key);
      writes.push(['delete', key]);
    },
    async list({ prefix = '' } = {}) {
      return new Map([...values].filter(([key]) => String(key).startsWith(prefix)));
    },
    setAlarm() {},
    deleteAlarm() {},
    transactionSync(operation) {
      if (transactionDepth > 0) return operation();
      database.exec('BEGIN IMMEDIATE');
      transactionDepth += 1;
      try {
        const value = operation();
        database.exec('COMMIT');
        return value;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        if (statement.columns().length > 0) return result(statement.all(...bindings));
        const write = statement.run(...bindings);
        return result([], Number(write.changes));
      },
    },
  };
  installAgentStorageKv(storage, { agentSchemaVersion: null });
  return storage;
}

export function makeAgentContext(storage, name = `${'a'.repeat(32)}-workspace-1`) {
  return {
    storage,
    id: { name, toString: () => name },
    blockConcurrencyWhile: async (operation) => operation(),
    getWebSockets: () => [],
    acceptWebSocket() {},
    waitUntil() {},
  };
}
