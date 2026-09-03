import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CameraLayer } from "../viewport/CameraLayer";
import { RenderNode } from "../node-renderer/RenderNode";
import { preloadFontsForNodeTree } from "../../core/fonts/loader";
import {
  EditorStore,
  EditorStoreContext,
  type EditorStore as EditorStoreType,
} from "../../core/state/EditorStore";
import { designNodeToPersistedNode, type PersistedEditorDocument } from "../../core/state/document";
import { waitForAnimationFrames } from "./render-settle";

const REPLICA_HOST_OFFSET_PX = -100_000;
const replicaQueues = new WeakMap<EditorStoreType, Promise<unknown>>();

/**
 * How long a settled replica stays mounted after its last read. Consecutive
 * DOM-dependent reads against the same unchanged background page (a tree
 * summary followed by a search, a batch of screenshots) then skip the
 * clone/render/settle rebuild entirely. Any document change disposes the
 * replica immediately, so the window only ever serves reads the rebuild would
 * have answered identically.
 */
const REPLICA_KEEP_ALIVE_MS = 5_000;

/**
 * A document change that stales a recently-read replica schedules a rebuild
 * off the read path, so an agent's next verify read after a write finds the
 * replica already settled. The debounce coalesces bursts of writes, and the
 * read-recency window keeps write-only sessions from paying for rebuilds
 * nobody will read.
 */
const PREWARM_DEBOUNCE_MS = 150;
const PREWARM_READ_WINDOW_MS = 15_000;

const lastReplicaReadAt = new WeakMap<EditorStoreType, number>();
const prewarmTimers = new WeakMap<EditorStoreType, ReturnType<typeof setTimeout>>();

interface CachedReplica {
  pageId: string;
  replicaStore: EditorStoreType;
  renderTreeVersion: number;
  /** Serialized page snapshot the replica rendered, for echo-change detection. */
  snapshotJson: string;
  stale: boolean;
  dispose: () => void;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
}

const replicaCache = new WeakMap<EditorStoreType, CachedReplica>();

function disposeCachedReplica(sourceStore: EditorStoreType) {
  const cached = replicaCache.get(sourceStore);
  if (!cached) return;
  replicaCache.delete(sourceStore);
  if (cached.expiryTimer !== undefined) clearTimeout(cached.expiryTimer);
  cached.dispose();
}

/** Subscribe to document-wide changes when the store's adapter supports it. */
function subscribeToDocumentChanges(store: EditorStoreType, callback: () => void) {
  const adapter = store.documentAdapter as
    | (typeof store.documentAdapter & { subscribe?: (callback: () => void) => () => void })
    | null;
  return adapter?.subscribe ? adapter.subscribe(callback) : null;
}

function snapshotPageDocument(store: EditorStoreType, pageId: string): PersistedEditorDocument {
  const sourcePage = store.pages.find((candidate) => candidate.id === pageId);
  if (!sourcePage) throw new Error(`Page not found: ${pageId}`);
  const page = {
    id: sourcePage.id,
    name: sourcePage.name,
    nodes: sourcePage.nodes.map(designNodeToPersistedNode),
    ...(sourcePage.camera ? { camera: { ...sourcePage.camera } } : {}),
  };
  return {
    version: 1,
    nodes: page.nodes,
    pages: [page],
  };
}

function targetNeedsReplica(store: EditorStoreType, pageId: string) {
  if (!store.pages.some((candidate) => candidate.id === pageId)) {
    throw new Error(`Page not found: ${pageId}`);
  }
  // The live DOM can only serve an active page whose editor canvas is mounted.
  // A store without a mounted canvas (a background workspace tab, or a window
  // showing the files dashboard) still answers document reads, but waiting on
  // its live elements would never resolve — replicate instead.
  return pageId !== store.activePageId || !store.hasMountedCanvas;
}

async function renderReplica<T>(
  sourceStore: EditorStoreType,
  pageId: string,
  run: (replicaStore: EditorStoreType) => Promise<T> | T,
  options: { prewarm?: boolean } = {},
): Promise<T> {
  if (!options.prewarm) lastReplicaReadAt.set(sourceStore, Date.now());
  const cached = replicaCache.get(sourceStore);
  let initialDocument: PersistedEditorDocument | undefined;
  let snapshotJson: string | undefined;
  if (cached && cached.pageId === pageId) {
    let reusable = !cached.stale && cached.renderTreeVersion === sourceStore.renderTreeVersion;
    if (!reusable) {
      // A change event alone does not prove the page content changed — a
      // collaboration document sees the server echo of its own local op as
      // another change. Snapshot-compare before paying the rebuild; on a
      // false alarm, refresh the entry instead.
      initialDocument = snapshotPageDocument(sourceStore, pageId);
      snapshotJson = JSON.stringify(initialDocument);
      if (snapshotJson === cached.snapshotJson) {
        cached.stale = false;
        cached.renderTreeVersion = sourceStore.renderTreeVersion;
        reusable = true;
      }
    }
    if (reusable) {
      if (options.prewarm) return await run(cached.replicaStore);
      // The keep-alive countdown must not start until `run` settles: a
      // callback that outlives the window (a screenshot batch waiting on an
      // image-decode timeout) would otherwise lose its DOM mid-read.
      if (cached.expiryTimer !== undefined) {
        clearTimeout(cached.expiryTimer);
        cached.expiryTimer = undefined;
      }
      try {
        return await run(cached.replicaStore);
      } finally {
        armReplicaExpiry(sourceStore, cached);
      }
    }
  }
  disposeCachedReplica(sourceStore);

  initialDocument ??= snapshotPageDocument(sourceStore, pageId);
  snapshotJson ??= JSON.stringify(initialDocument);
  const snapshotRenderTreeVersion = sourceStore.renderTreeVersion;
  const replicaStore = new EditorStore({ initialDocument });
  // Subscribe before the async settling below: a source change while replica
  // construction awaits fonts or animation frames must not be missed, or the
  // cache entry would publish a pre-change snapshot stamped as fresh.
  let changedDuringBuild = false;
  const unsubscribe = subscribeToDocumentChanges(sourceStore, () => {
    const entry = replicaCache.get(sourceStore);
    if (entry?.replicaStore === replicaStore) {
      entry.stale = true;
      scheduleReplicaPrewarm(sourceStore, pageId);
    } else {
      changedDuringBuild = true;
    }
  });
  const page = replicaStore.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    unsubscribe?.();
    throw new Error(`Page not found: ${pageId}`);
  }
  try {
    await preloadFontsForNodeTree(page.nodes);
  } catch (error) {
    unsubscribe?.();
    throw error;
  }
  replicaStore.activePageId = pageId;
  replicaStore.zoom = 1;
  replicaStore.panX = 0;
  replicaStore.panY = 0;

  const host = document.createElement("div");
  host.dataset.mcpRenderReplica = pageId;
  host.dataset.viewport = "";
  Object.assign(host.style, {
    contain: "layout style paint",
    height: "0",
    left: `${REPLICA_HOST_OFFSET_PX}px`,
    overflow: "visible",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "0",
    zIndex: "-2147483648",
  });
  document.body.appendChild(host);

  const root = createRoot(host);
  const dispose = () => {
    root.unmount();
    host.remove();
  };
  try {
    flushSync(() => {
      root.render(
        <EditorStoreContext.Provider value={replicaStore}>
          <CameraLayer suppressNativeSelection>
            {page.nodes.map((node) => (
              <RenderNode
                key={node.id}
                node={node}
                forceDetail
                isInteractionSuppressed
                renderChildren
              />
            ))}
          </CameraLayer>
        </EditorStoreContext.Provider>,
      );
    });

    await waitForAnimationFrames(2);
    await document.fonts?.ready;
    await waitForAnimationFrames(1);
  } catch (error) {
    unsubscribe?.();
    dispose();
    throw error;
  }

  // A settled replica is only reusable when the source document can tell us it
  // changed; mark it stale rather than unmounting so an in-flight read is
  // never pulled out from under `run`. Without a change subscription the
  // replica stays single-use.
  if (!unsubscribe) {
    try {
      return await run(replicaStore);
    } finally {
      dispose();
    }
  }

  const entry: CachedReplica = {
    pageId,
    replicaStore,
    // Stamp the version captured with the snapshot, and publish as stale when
    // the source changed during construction, so the next read revalidates
    // against the live document instead of trusting a pre-change snapshot.
    renderTreeVersion: snapshotRenderTreeVersion,
    snapshotJson,
    stale: changedDuringBuild,
    dispose: () => {
      unsubscribe();
      dispose();
    },
    expiryTimer: undefined,
  };
  replicaCache.set(sourceStore, entry);
  if (changedDuringBuild && !options.prewarm) scheduleReplicaPrewarm(sourceStore, pageId);
  try {
    return await run(replicaStore);
  } finally {
    armReplicaExpiry(sourceStore, entry);
  }
}

/** Start (or restart) the post-read keep-alive countdown for a cached replica. */
function armReplicaExpiry(sourceStore: EditorStoreType, entry: CachedReplica) {
  if (replicaCache.get(sourceStore) !== entry) return;
  if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
  entry.expiryTimer = setTimeout(() => disposeCachedReplica(sourceStore), REPLICA_KEEP_ALIVE_MS);
}

/**
 * Run a DOM-dependent MCP read against an isolated editor projection.
 *
 * The authoritative store remains the write/session owner. Inactive pages —
 * and any page of a store with no mounted editor canvas, such as a background
 * workspace tab — are cloned into a read-only render store with independent
 * page, camera, selection, interaction, and DOM-index state.
 */
export async function withMcpPageRenderStore<T>(
  store: EditorStoreType,
  pageId: string,
  run: (renderStore: EditorStoreType) => Promise<T> | T,
): Promise<T> {
  if (typeof document === "undefined" || !targetNeedsReplica(store, pageId)) {
    return await run(store);
  }
  // A real read supersedes any pending prewarm: it rebuilds or reuses on its
  // own, and a prewarm firing mid-sequence would only queue a second rebuild
  // ahead of the calls that follow.
  const pendingPrewarm = prewarmTimers.get(store);
  if (pendingPrewarm !== undefined) {
    clearTimeout(pendingPrewarm);
    prewarmTimers.delete(store);
  }
  return await enqueueReplicaTask(store, () => renderReplica(store, pageId, run));
}

function enqueueReplicaTask<T>(store: EditorStoreType, task: () => Promise<T>): Promise<T> {
  const previous = replicaQueues.get(store) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  replicaQueues.set(
    store,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

function scheduleReplicaPrewarm(sourceStore: EditorStoreType, pageId: string) {
  const lastRead = lastReplicaReadAt.get(sourceStore);
  if (lastRead === undefined || Date.now() - lastRead > PREWARM_READ_WINDOW_MS) return;
  const pending = prewarmTimers.get(sourceStore);
  if (pending !== undefined) clearTimeout(pending);
  prewarmTimers.set(
    sourceStore,
    setTimeout(() => {
      prewarmTimers.delete(sourceStore);
      try {
        // The page may have been deleted or become the mounted active page
        // since the write; neither needs a replica any more.
        if (!targetNeedsReplica(sourceStore, pageId)) return;
      } catch {
        return;
      }
      void enqueueReplicaTask(sourceStore, () =>
        renderReplica(sourceStore, pageId, () => undefined, { prewarm: true }),
      ).catch(() => undefined);
    }, PREWARM_DEBOUNCE_MS),
  );
}

/** Test-only: the currently cached replica store, without touching its TTL. */
export function peekCachedReplicaStoreForTests(store: EditorStoreType) {
  return replicaCache.get(store)?.replicaStore;
}
