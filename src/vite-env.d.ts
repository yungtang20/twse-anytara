/// <reference types="vite/client" />

declare module 'better-sqlite3' {
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
    transaction(fn: (...args: unknown[]) => unknown): Transaction;
    pragma(pragma: string, options?: { simple: boolean }): unknown;
    backup(destination: string): Promise<BackupResult>;
    serialize(options?: { attached?: string }): Buffer;
    function(key: string, fn: (...args: unknown[]) => unknown): void;
    loadExtension(path: string): void;
    enableForeignKeyConstraints(enabled: boolean): void;
    get inTransaction(): boolean;
  }

  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
    pluck(enabled?: boolean): this;
    expand(enabled?: boolean): this;
    raw(enabled?: boolean): this;
    columns(): ColumnDefinition[];
    safeIntegers(enabled?: boolean): this;
    busytimeout(ms: number): this;
    stmt: { readonly sql: string; readonly readonly: boolean };
  }

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface ColumnDefinition {
    name: string;
    column: string | null;
    table: string | null;
    database: string | null;
    type: string | null;
  }

  interface Transaction {
    (...args: unknown[]): unknown;
    default: (...args: unknown[]) => unknown;
    deferred: (...args: unknown[]) => unknown;
    immediate: (...args: unknown[]) => unknown;
    exclusive: (...args: unknown[]) => unknown;
  }

  interface BackupResult {
    totalPages: number;
    remainingPages: number;
  }

  interface BetterSqlite3Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | null;
    nativeBinding?: string;
  }

  const Database: new (filename: string | Buffer, options?: BetterSqlite3Options) => Database;
  export default Database;
  export { Database, Statement, RunResult, ColumnDefinition, Transaction, BackupResult, BetterSqlite3Options };
}
