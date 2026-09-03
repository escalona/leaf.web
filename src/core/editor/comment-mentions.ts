/**
 * @mentions in comment bodies.
 *
 * Bodies are Leaf markup strings (see `src/markup`); a mention is the inline
 * token `@[Name](actor-id)`. The name inside the token is only a snapshot for
 * degraded rendering — the renderer resolves the CURRENT display name from
 * the actor id at render time, so a body always shows people's current names.
 * The roster is built from everyone this session can see: the session author,
 * every author on existing comment records, and live presence peers.
 */
import type { LeafCommentRecord } from "../shared/collaboration";
import type { EditorStore } from "../state/EditorStore";

export type MentionMember = { id: string; name: string };

function displayNameFor(record: LeafCommentRecord): { id: string; name: string | null } {
  switch (record.kind) {
    case "thread":
      return { id: record.createdBy, name: record.createdByName };
    case "comment":
      return { id: record.authorId, name: record.authorName };
    case "reaction":
      return { id: record.userId, name: record.userName };
  }
}

/**
 * Everyone mentionable from this session, best-name-wins: the session author,
 * every identity on existing comment records, and live presence peers.
 */
export function mentionRoster(
  store: EditorStore,
  presencePeers: ReadonlyArray<{ actorId: string; displayName: string | null }> = [],
): MentionMember[] {
  const names = new Map<string, string | null>();
  const remember = (id: string, name: string | null) => {
    if (!id) return;
    const existing = names.get(id);
    if (existing === undefined || (!existing && name)) names.set(id, name);
  };
  const self = store.commentAuthor;
  if (self) remember(self.id, self.name);
  for (const record of store.commentRecords.values()) {
    const identity = displayNameFor(record);
    remember(identity.id, identity.name);
  }
  for (const peer of presencePeers) remember(peer.actorId, peer.displayName);
  return [...names.entries()]
    .map(([id, name]) => ({ id, name: name?.trim() || fallbackMentionName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A readable stand-in when an actor has no display name. */
function fallbackMentionName(actorId: string): string {
  if (actorId.startsWith("agent:")) return actorId.slice("agent:".length);
  return actorId.length > 12 ? `${actorId.slice(0, 12)}…` : actorId;
}

/** The current name for a mentioned actor, resolved through the roster. */
export function resolveMentionName(
  store: EditorStore,
  actorId: string,
  fallbackName: string,
): string {
  if (store.commentAuthor?.id === actorId) return "You";
  for (const record of store.commentRecords.values()) {
    const identity = displayNameFor(record);
    if (identity.id === actorId && identity.name?.trim()) return identity.name;
  }
  return fallbackName || fallbackMentionName(actorId);
}

export function filterMentionMembers(members: MentionMember[], query: string): MentionMember[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return members;
  return members.filter(
    (member) =>
      member.name.toLowerCase().includes(needle) || member.id.toLowerCase().includes(needle),
  );
}
