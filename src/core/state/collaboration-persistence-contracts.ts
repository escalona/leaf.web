/**
 * Stable contracts shared by collaboration persistence facades and backends.
 *
 * These types deliberately have no transport, React, MobX, or editor-runtime dependency.
 * Callers own the payload shapes; every persisted payload must be structured-cloneable.
 */

export const COLLABORATION_PERSISTENCE_VERSION = 2 as const;

export const COLLABORATION_PERSISTENCE_STORE_NAMES = [
  "namespaces",
  "generations",
  "pending",
] as const;

export type CollaborationPersistenceStoreName =
  (typeof COLLABORATION_PERSISTENCE_STORE_NAMES)[number];
export type CollaborationPersistenceDurability = "durable" | "memory";
export type CollaborationPersistenceFailureReason = "quota" | "unavailable";

export interface CollaborationCacheIdentity {
  accountId: string;
  workspaceId: string;
  fileId: string;
  branchId: string;
  schemaVersion: number;
}

export interface CollaborationCursorMetadata {
  streamEpoch: string;
  revision: number;
}

export interface CollaborationCheckpointMetadata extends CollaborationCursorMetadata {
  checkpointId: string;
  manifestHash: string;
}

export interface CollaborationCommittedGeneration<ConfirmedPayload, HistoryMetadata> {
  generationId: string;
  installedAtMs: number;
  cursor: CollaborationCursorMetadata;
  checkpoint: CollaborationCheckpointMetadata | null;
  confirmed: ConfirmedPayload;
  history: HistoryMetadata | null;
}

export interface CollaborationPendingTransaction<PendingPayload> {
  clientInstanceId: string;
  clientTxId: string;
  clientSequence: number;
  createdAtMs: number;
  dependsOnClientTxId?: string;
  /**
   * The authoritative commit that acknowledged this transaction, stamped when
   * the acknowledgement lands while the active committed generation still
   * predates the commit. The row is retained as the crash-safe local replay
   * source until a generation covering the commit installs and removes it in
   * the same backend transaction.
   */
  acknowledged?: { streamEpoch: string; revision: number };
  payload: PendingPayload;
}

export type CollaborationPermanentWriteFenceKind = "read-only" | "archived";

export interface CollaborationPermanentWriteFence {
  kind: CollaborationPermanentWriteFenceKind;
  fencedAtMs: number;
}

export interface CollaborationPersistenceSnapshot<
  ConfirmedPayload,
  PendingPayload,
  HistoryMetadata,
> {
  identity: CollaborationCacheIdentity;
  activeGeneration: CollaborationCommittedGeneration<ConfirmedPayload, HistoryMetadata> | null;
  acceptedClientSequences: Record<string, number>;
  permanentWriteFence: CollaborationPermanentWriteFence | null;
  pendingTransactions: CollaborationPendingTransaction<PendingPayload>[];
}

export interface CollaborationAcknowledgedSequence {
  clientInstanceId: string;
  clientSequence: number;
  streamEpoch: string;
  /** Revision of the authoritative commit that acknowledged the transaction. */
  revision: number;
}

export interface CollaborationPersistenceBackendTransaction {
  get<T>(storeName: CollaborationPersistenceStoreName, key: string): Promise<T | undefined>;
  put<T>(storeName: CollaborationPersistenceStoreName, key: string, value: T): Promise<void>;
  delete(storeName: CollaborationPersistenceStoreName, key: string): Promise<void>;
  /** List entries, optionally restricted to keys with the given prefix. */
  entries<T>(
    storeName: CollaborationPersistenceStoreName,
    keyPrefix?: string,
  ): Promise<Array<{ key: string; value: T }>>;
}

export interface CollaborationPersistenceBackend {
  readonly durability: CollaborationPersistenceDurability;
  transaction<T>(
    storeNames: readonly CollaborationPersistenceStoreName[],
    mode: "readonly" | "readwrite",
    operation: (transaction: CollaborationPersistenceBackendTransaction) => Promise<T>,
  ): Promise<T>;
  close?(): void | Promise<void>;
}

export class CollaborationPersistenceBackendError extends Error {
  constructor(
    readonly reason: CollaborationPersistenceFailureReason,
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(`Collaboration persistence ${operation} failed (${reason}).`, options);
    this.name = "CollaborationPersistenceBackendError";
  }
}

export class CollaborationPersistenceDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationPersistenceDataError";
  }
}
