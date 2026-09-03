import {
  COLLABORATION_PERSISTENCE_STORE_NAMES,
  CollaborationPersistenceBackendError,
  type CollaborationPersistenceBackend,
  type CollaborationPersistenceBackendTransaction,
  type CollaborationPersistenceStoreName,
} from "./collaboration-persistence-contracts";
import { CollaborationPersistence } from "./collaboration-persistence-core";

const DEFAULT_DATABASE_NAME = "leaf-collaboration";
const DATABASE_VERSION = 1;

export interface IndexedDbCollaborationPersistenceBackendOptions {
  databaseName?: string;
  factory?: IDBFactory | null;
}

/** Native IndexedDB backend; all multi-store writes use one IDB transaction. */
export class IndexedDbCollaborationPersistenceBackend implements CollaborationPersistenceBackend {
  readonly durability = "durable" as const;
  private readonly databaseName: string;
  private readonly factory: IDBFactory | null;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbCollaborationPersistenceBackendOptions = {}) {
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.factory =
      options.factory === undefined
        ? typeof indexedDB === "undefined"
          ? null
          : indexedDB
        : options.factory;
  }

  async transaction<T>(
    storeNames: readonly CollaborationPersistenceStoreName[],
    mode: "readonly" | "readwrite",
    operation: (transaction: CollaborationPersistenceBackendTransaction) => Promise<T>,
  ): Promise<T> {
    const database = await this.openDatabase();
    const names = normalizeStoreNames(storeNames);
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(names, mode);
    } catch (error) {
      throw new CollaborationPersistenceBackendError("unavailable", "open transaction", {
        cause: error,
      });
    }
    const completed = idbTransactionComplete(transaction);
    const adapter = createIndexedDbTransaction(transaction, names);
    try {
      const result = await operation(adapter);
      await completed;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted or completed.
      }
      await completed.catch(() => undefined);
      throw error;
    }
  }

  close() {
    void this.databasePromise?.then((database) => database.close()).catch(() => undefined);
    this.databasePromise = null;
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!this.factory) {
      return Promise.reject(
        new CollaborationPersistenceBackendError("unavailable", "open database"),
      );
    }
    if (this.databasePromise) return this.databasePromise;
    const factory = this.factory;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.databaseName, DATABASE_VERSION);
      } catch (error) {
        reject(
          new CollaborationPersistenceBackendError("unavailable", "open database", {
            cause: error,
          }),
        );
        return;
      }
      request.onupgradeneeded = () => {
        for (const storeName of COLLABORATION_PERSISTENCE_STORE_NAMES) {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName);
          }
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
      request.onblocked = () =>
        reject(new CollaborationPersistenceBackendError("unavailable", "open database"));
    }).catch((error) => {
      this.databasePromise = null;
      throw error;
    });
    return this.databasePromise;
  }
}

export function createBrowserCollaborationPersistence<
  ConfirmedPayload = unknown,
  PendingPayload = unknown,
  HistoryMetadata = unknown,
>(options: IndexedDbCollaborationPersistenceBackendOptions = {}) {
  return new CollaborationPersistence<ConfirmedPayload, PendingPayload, HistoryMetadata>(
    new IndexedDbCollaborationPersistenceBackend(options),
  );
}

function normalizeStoreNames(storeNames: readonly CollaborationPersistenceStoreName[]) {
  const names = [...new Set(storeNames)];
  if (names.length === 0) throw new Error("Persistence transaction requires a store.");
  return names;
}

function createIndexedDbTransaction(
  transaction: IDBTransaction,
  selectedNames: readonly CollaborationPersistenceStoreName[],
): CollaborationPersistenceBackendTransaction {
  const selected = new Set(selectedNames);
  const getStore = (storeName: CollaborationPersistenceStoreName) => {
    if (!selected.has(storeName)) {
      throw new Error(`Store ${storeName} is outside this persistence transaction.`);
    }
    return transaction.objectStore(storeName);
  };
  return {
    async get<T>(
      storeName: CollaborationPersistenceStoreName,
      key: string,
    ): Promise<T | undefined> {
      return (await idbRequest(getStore(storeName).get(key))) as T | undefined;
    },
    async put<T>(storeName: CollaborationPersistenceStoreName, key: string, value: T) {
      await idbRequest(getStore(storeName).put(value, key));
    },
    async delete(storeName: CollaborationPersistenceStoreName, key: string) {
      await idbRequest(getStore(storeName).delete(key));
    },
    async entries<T>(storeName: CollaborationPersistenceStoreName, keyPrefix?: string) {
      return await idbEntries<T>(getStore(storeName), keyPrefix);
    },
  };
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function idbEntries<T>(
  store: IDBObjectStore,
  keyPrefix?: string,
): Promise<Array<{ key: string; value: T }>> {
  return new Promise((resolve, reject) => {
    const entries: Array<{ key: string; value: T }> = [];
    // A prefix cursor walks only the target namespace instead of every
    // document's rows; "\uffff" upper-bounds all string keys with the prefix.
    const range = keyPrefix
      ? IDBKeyRange.bound(keyPrefix, `${keyPrefix}\uffff`, false, false)
      : undefined;
    const request = store.openCursor(range);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      if (typeof cursor.key !== "string") {
        reject(new Error("Collaboration persistence encountered a non-string key."));
        return;
      }
      entries.push({ key: cursor.key, value: cursor.value as T });
      cursor.continue();
    };
  });
}

function idbTransactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted."));
  });
}
