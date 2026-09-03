import { stableStringify } from "./canonical-json";
import { LeafReferenceDocument } from "./model";
import type { LeafCanonicalPatch, LeafNodeRecord, LeafSemanticCommand } from "./protocol";

export interface LeafSimulationRequest {
  baseRevision: number;
  clientTxId: string;
  commands: readonly LeafSemanticCommand[];
}

export interface LeafSimulationCommit {
  type: "commit" | "rebase";
  actorId: string;
  clientTxId: string;
  effectivePatches: LeafCanonicalPatch[];
  revision: number;
  touchedNodeIds: string[];
}

export interface LeafSimulationSubmission {
  commit: LeafSimulationCommit;
  duplicate: boolean;
}

interface LeafSimulationReceipt {
  commit: LeafSimulationCommit;
  requestHash: string;
}

/**
 * Deterministic, transport-free authority used to prove protocol behavior before
 * involving WebSockets, IndexedDB, or Durable Objects.
 */
export class LeafCollaborationSimulator {
  private readonly authority: LeafReferenceDocument;
  private readonly clients = new Map<string, LeafSimulatedClient>();
  private readonly receipts = new Map<string, LeafSimulationReceipt>();
  private readonly committed: LeafSimulationCommit[] = [];
  private currentRevision = 0;

  constructor(records: readonly LeafNodeRecord[]) {
    this.authority = new LeafReferenceDocument(records);
  }

  get revision() {
    return this.currentRevision;
  }

  get records(): ReadonlyMap<string, LeafNodeRecord> {
    return this.authority.records;
  }

  get commits(): readonly LeafSimulationCommit[] {
    return this.committed;
  }

  connect(clientId: string): LeafSimulatedClient {
    validateId(clientId, "Client id");
    if (this.clients.has(clientId)) {
      throw new LeafSimulationError("duplicate_client", `Client is already connected: ${clientId}`);
    }
    const client = new LeafSimulatedClient(
      this,
      clientId,
      this.authority.snapshot(),
      this.currentRevision,
    );
    this.clients.set(clientId, client);
    return client;
  }

  submit(clientId: string, request: LeafSimulationRequest): LeafSimulationSubmission {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new LeafSimulationError("unknown_client", `Client is not connected: ${clientId}`);
    }
    validateRequest(request);
    if (request.baseRevision > this.currentRevision) {
      throw new LeafSimulationError(
        "future_revision",
        `Base revision ${request.baseRevision} is ahead of ${this.currentRevision}.`,
      );
    }

    const receiptKey = `${clientId}\u0000${request.clientTxId}`;
    const requestHash = stableStringify(request);
    const receipt = this.receipts.get(receiptKey);
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw new LeafSimulationError(
          "idempotency_mismatch",
          `Client transaction id was reused with different content: ${request.clientTxId}`,
        );
      }
      return { commit: receipt.commit, duplicate: true };
    }

    const prepared = this.authority.commit(request.commands);
    const commit: LeafSimulationCommit = {
      type: request.baseRevision === this.currentRevision ? "commit" : "rebase",
      actorId: clientId,
      clientTxId: request.clientTxId,
      effectivePatches: prepared.forward,
      revision: this.currentRevision + 1,
      touchedNodeIds: prepared.touchedNodeIds,
    };
    this.currentRevision = commit.revision;
    this.receipts.set(receiptKey, { commit, requestHash });
    this.committed.push(commit);

    // Map insertion order is the deterministic broadcast order. Every client
    // applies only the canonical write set and advances one contiguous revision.
    for (const target of this.clients.values()) target.receive(commit);
    return { commit, duplicate: false };
  }
}

export class LeafSimulatedClient {
  private readonly replica: LeafReferenceDocument;
  private confirmedRevision: number;

  constructor(
    private readonly simulator: LeafCollaborationSimulator,
    readonly id: string,
    records: readonly LeafNodeRecord[],
    revision: number,
  ) {
    this.replica = new LeafReferenceDocument(records);
    this.confirmedRevision = revision;
  }

  get revision() {
    return this.confirmedRevision;
  }

  get records(): ReadonlyMap<string, LeafNodeRecord> {
    return this.replica.records;
  }

  createRequest(
    clientTxId: string,
    commands: readonly LeafSemanticCommand[],
  ): LeafSimulationRequest {
    return {
      baseRevision: this.confirmedRevision,
      clientTxId,
      commands,
    };
  }

  submit(clientTxId: string, commands: readonly LeafSemanticCommand[]): LeafSimulationSubmission {
    return this.simulator.submit(this.id, this.createRequest(clientTxId, commands));
  }

  /** @internal The authority is the only caller; clients cannot author patches. */
  receive(commit: LeafSimulationCommit) {
    const expectedRevision = this.confirmedRevision + 1;
    if (commit.revision !== expectedRevision) {
      throw new LeafSimulationError(
        "revision_gap",
        `Client ${this.id} expected revision ${expectedRevision}, received ${commit.revision}.`,
      );
    }
    this.replica.apply(commit.effectivePatches);
    this.confirmedRevision = commit.revision;
  }
}

export class LeafSimulationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function validateRequest(request: LeafSimulationRequest) {
  validateId(request.clientTxId, "Client transaction id");
  if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
    throw new LeafSimulationError("invalid_request", "Base revision must be non-negative.");
  }
  if (!Array.isArray(request.commands) || request.commands.length === 0) {
    throw new LeafSimulationError("invalid_request", "A simulation request requires commands.");
  }
}

function validateId(value: string, label: string) {
  if (!value || value.length > 256) {
    throw new LeafSimulationError("invalid_request", `${label} is invalid.`);
  }
}
