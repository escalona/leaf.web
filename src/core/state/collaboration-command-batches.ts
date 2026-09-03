import {
  LeafReferenceDocument,
  type LeafNodeRecord,
  type LeafPreparedTransaction,
  type LeafSemanticCommand,
} from "../shared/collaboration";

/** Keep browser-authored transactions comfortably below the Worker hard limits. */
export const LEAF_CLIENT_TRANSACTION_RECORD_LIMIT = 1_000;
export const LEAF_CLIENT_TRANSACTION_COMMAND_LIMIT = 100;
export const LEAF_CLIENT_TRANSACTION_WIRE_BYTES = 320 * 1024;
export const LEAF_CLIENT_TRANSACTION_JOURNAL_BYTES = 1_250_000;

export type LeafSemanticCommandBatch = {
  commands: LeafSemanticCommand[];
  prepared: LeafPreparedTransaction;
};

/**
 * Expands large semantic operations into ordered transactions. Every returned
 * batch can use the same history group, so the authority still exposes one
 * undo/redo action for a large paste, import, replacement, or subtree delete.
 */
export function batchLeafSemanticCommands(
  document: LeafReferenceDocument,
  commands: readonly LeafSemanticCommand[],
): LeafSemanticCommandBatch[] {
  if (commands.length === 0) return [];
  const obviouslyTooLarge =
    commands.length > LEAF_CLIENT_TRANSACTION_COMMAND_LIMIT ||
    commands.reduce(
      (count, command) => count + (command.type === "createRecords" ? command.records.length : 0),
      0,
    ) > LEAF_CLIENT_TRANSACTION_RECORD_LIMIT;
  if (!obviouslyTooLarge) {
    const direct = document.prepare(commands);
    if (isPreparedBatchWithinLimits(commands, direct)) {
      return [{ commands: structuredClone([...commands]), prepared: direct }];
    }
  }
  const expansionDocument = document.fork();
  const expanded: LeafSemanticCommand[] = [];

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
    const command = commands[commandIndex]!;
    if (command.type === "createRecords") {
      expanded.push(...splitCreateRecords(expansionDocument, command.records));
    } else if (command.type === "deleteSubtree") {
      expanded.push(...planBoundedSubtreeDeletes(expansionDocument, command.nodeId));
    } else {
      expanded.push(structuredClone(command));
    }
    if (commandIndex + 1 < commands.length) expansionDocument.commit([command]);
  }

  const working = document.fork();
  const batches: LeafSemanticCommandBatch[] = [];
  let pending: LeafSemanticCommand[] = [];
  let pendingPrepared: LeafPreparedTransaction[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const prepared = combinePreparedTransactions(pendingPrepared);
    assertPreparedBatchWithinLimits(pending, prepared);
    batches.push({ commands: structuredClone(pending), prepared });
    pending = [];
    pendingPrepared = [];
  };

  for (const command of expanded) {
    const singlePrepared = working.prepare([command]);
    const candidate = [...pending, command];
    const candidatePrepared = combinePreparedTransactions([...pendingPrepared, singlePrepared]);
    if (isPreparedBatchWithinLimits(candidate, candidatePrepared)) {
      pending = candidate;
      pendingPrepared.push(singlePrepared);
      working.apply(singlePrepared.forward);
      continue;
    }
    flush();
    assertPreparedBatchWithinLimits([command], singlePrepared);
    pending = [command];
    pendingPrepared = [singlePrepared];
    working.apply(singlePrepared.forward);
  }
  flush();
  return batches;
}

function combinePreparedTransactions(
  transactions: readonly LeafPreparedTransaction[],
): LeafPreparedTransaction {
  const touchedNodeIds = new Set<string>();
  for (const transaction of transactions) {
    for (const nodeId of transaction.touchedNodeIds) touchedNodeIds.add(nodeId);
  }
  return {
    forward: transactions.flatMap((transaction) => transaction.forward),
    inverse: [...transactions].reverse().flatMap((transaction) => transaction.inverse),
    touchedNodeIds: [...touchedNodeIds],
  };
}

function splitCreateRecords(
  document: LeafReferenceDocument,
  records: readonly LeafNodeRecord[],
): LeafSemanticCommand[] {
  const ordered = topologicallyOrderCreatedRecords(document, records);
  const commands: LeafSemanticCommand[] = [];
  let batch: LeafNodeRecord[] = [];
  const emptyCommandBytes = encodedBytes({ type: "createRecords", records: [] });
  let batchBytes = emptyCommandBytes;

  const flush = () => {
    if (batch.length === 0) return;
    commands.push({ type: "createRecords", records: structuredClone(batch) });
    batch = [];
    batchBytes = emptyCommandBytes;
  };

  for (const record of ordered) {
    const encodedRecordBytes = encodedBytes(record);
    const recordBytes = encodedRecordBytes + (batch.length ? 1 : 0);
    if (
      batch.length > 0 &&
      (batch.length + 1 > LEAF_CLIENT_TRANSACTION_RECORD_LIMIT ||
        batchBytes + recordBytes > LEAF_CLIENT_TRANSACTION_WIRE_BYTES)
    ) {
      flush();
    }
    batch.push(record);
    batchBytes += encodedRecordBytes + (batch.length > 1 ? 1 : 0);
  }
  flush();
  return commands;
}

function topologicallyOrderCreatedRecords(
  document: LeafReferenceDocument,
  records: readonly LeafNodeRecord[],
) {
  const pending = new Map(records.map((record) => [record.id, structuredClone(record)]));
  const available = new Set(document.records.keys());
  const ordered: LeafNodeRecord[] = [];
  while (pending.size) {
    let progressed = false;
    for (const [id, record] of pending) {
      if (record.parentId !== null && !available.has(record.parentId)) continue;
      ordered.push(record);
      available.add(id);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) throw new Error("Created records contain a missing parent or cycle");
  }
  return ordered;
}

function planBoundedSubtreeDeletes(document: LeafReferenceDocument, rootId: string) {
  if (!document.records.has(rootId)) throw new Error(`Node not found: ${rootId}`);
  const children = new Map<string, string[]>();
  for (const record of document.records.values()) {
    if (!record.parentId) continue;
    const siblings = children.get(record.parentId) ?? [];
    siblings.push(record.id);
    children.set(record.parentId, siblings);
  }
  const subtreeRecords = new Map<string, number>();
  const subtreeBytes = new Map<string, number>();
  const postorder: Array<{ id: string; visited: boolean }> = [{ id: rootId, visited: false }];
  while (postorder.length) {
    const entry = postorder.pop()!;
    if (!entry.visited) {
      postorder.push({ ...entry, visited: true });
      for (const child of children.get(entry.id) ?? []) {
        postorder.push({ id: child, visited: false });
      }
      continue;
    }
    const record = document.records.get(entry.id)!;
    const descendants = children.get(entry.id) ?? [];
    subtreeRecords.set(
      entry.id,
      1 + descendants.reduce((total, child) => total + (subtreeRecords.get(child) ?? 0), 0),
    );
    subtreeBytes.set(
      entry.id,
      encodedBytes(record) +
        descendants.reduce((total, child) => total + (subtreeBytes.get(child) ?? 0), 0),
    );
  }

  const commands: LeafSemanticCommand[] = [];
  const plan: Array<{ id: string; visited: boolean }> = [{ id: rootId, visited: false }];
  while (plan.length) {
    const entry = plan.pop()!;
    const recordCount = subtreeRecords.get(entry.id)!;
    const byteLength = subtreeBytes.get(entry.id)!;
    if (
      recordCount <= LEAF_CLIENT_TRANSACTION_RECORD_LIMIT &&
      byteLength <= LEAF_CLIENT_TRANSACTION_WIRE_BYTES
    ) {
      commands.push({ type: "deleteSubtree", nodeId: entry.id });
      continue;
    }
    if (entry.visited) {
      commands.push({ type: "deleteSubtree", nodeId: entry.id });
      continue;
    }
    plan.push({ ...entry, visited: true });
    const descendants = children.get(entry.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      plan.push({ id: descendants[index]!, visited: false });
    }
  }
  return commands;
}

function isPreparedBatchWithinLimits(
  commands: readonly LeafSemanticCommand[],
  prepared: LeafPreparedTransaction,
) {
  return (
    commands.length <= LEAF_CLIENT_TRANSACTION_COMMAND_LIMIT &&
    prepared.touchedNodeIds.length <= LEAF_CLIENT_TRANSACTION_RECORD_LIMIT &&
    encodedBytes({ commands }) <= LEAF_CLIENT_TRANSACTION_WIRE_BYTES &&
    encodedBytes(prepared.forward) + encodedBytes(prepared.inverse) <=
      LEAF_CLIENT_TRANSACTION_JOURNAL_BYTES
  );
}

function assertPreparedBatchWithinLimits(
  commands: readonly LeafSemanticCommand[],
  prepared: LeafPreparedTransaction,
) {
  if (!isPreparedBatchWithinLimits(commands, prepared)) {
    throw new Error("One collaboration operation exceeds the safe transaction budget");
  }
}

function encodedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
