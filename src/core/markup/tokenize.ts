/**
 * Leaf markup: the inline grammar for plain-string rich text.
 *
 * Bodies stay ordinary strings on the wire (a comment body is stored and
 * synced exactly as typed); this module owns the ONE definition of how those
 * strings are read back as structure. The grammar is a deliberately tiny
 * CommonMark subset — agents emit it natively through MCP, and a string that
 * uses none of it tokenizes to itself:
 *
 *   @[Name](actor-id)   mention (the name is a snapshot; render live names)
 *   `code`              literal span, nothing parses inside
 *   [text](https://…)   link — http(s) only, anything else stays text
 *   https://…           bare URLs autolink, trailing punctuation excluded
 *   **strong** *em*     emphasis, inner content parses recursively
 *
 * No token crosses a newline and there are no backslash escapes: a literal
 * `*` or backtick that the rules above would eat belongs in a code span.
 */

export type MarkupToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; href: string; text: string }
  | { type: "mention"; actorId: string; label: string }
  | { type: "strong"; children: MarkupToken[] }
  | { type: "em"; children: MarkupToken[] };

const MENTION_PATTERN = /@\[([^\]\n]{1,80})\]\(([^)\n]{1,256})\)/y;
const LINK_PATTERN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,1024})\)/iy;
const AUTOLINK_PATTERN = /https?:\/\/[^\s<>]{1,1024}/iy;
/** Sentence punctuation after a bare URL belongs to the sentence, not the URL. */
const AUTOLINK_TRAILING = /[.,;:!?'"]+$/;

/** Builds the mention token `parseMarkup` reads back, sanitized to stay one token. */
export function mentionMarkup(member: { id: string; name: string }): string {
  const label = member.name.replaceAll("]", "").replaceAll("\n", " ").slice(0, 80) || "unknown";
  const id = member.id.replaceAll(")", "").replaceAll("\n", "").slice(0, 256);
  return `@[${label}](${id})`;
}

export function parseMarkup(body: string): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  let plainStart = 0;
  let index = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) tokens.push({ type: "text", text: body.slice(plainStart, end) });
  };

  while (index < body.length) {
    const char = body[index]!;
    let match: MarkupToken | null = null;
    let matchEnd = index;

    if (char === "@") {
      MENTION_PATTERN.lastIndex = index;
      const hit = MENTION_PATTERN.exec(body);
      if (hit) {
        match = { type: "mention", actorId: hit[2]!, label: hit[1]! };
        matchEnd = index + hit[0].length;
      }
    } else if (char === "`") {
      const close = findBeforeNewline(body, "`", index + 1);
      if (close > index + 1) {
        match = { type: "code", text: body.slice(index + 1, close) };
        matchEnd = close + 1;
      }
    } else if (char === "[") {
      LINK_PATTERN.lastIndex = index;
      const hit = LINK_PATTERN.exec(body);
      if (hit) {
        match = { type: "link", href: hit[2]!, text: hit[1]! };
        matchEnd = index + hit[0].length;
      }
    } else if (char === "h" || char === "H") {
      const boundary = index === 0 || /[\s([{'"<]/.test(body[index - 1]!);
      if (boundary) {
        AUTOLINK_PATTERN.lastIndex = index;
        const hit = AUTOLINK_PATTERN.exec(body);
        if (hit) {
          const url = trimAutolink(hit[0]);
          match = { type: "link", href: url, text: url };
          matchEnd = index + url.length;
        }
      }
    } else if (char === "*") {
      const strong = body.startsWith("**", index) ? matchEmphasis(body, index, "**") : null;
      const emphasis = strong ?? matchEmphasis(body, index, "*");
      if (emphasis) {
        match = {
          type: strong ? "strong" : "em",
          children: parseMarkup(emphasis.content),
        };
        matchEnd = emphasis.end;
      }
    }

    if (match) {
      flushPlain(index);
      tokens.push(match);
      index = matchEnd;
      plainStart = index;
    } else {
      index += 1;
    }
  }
  flushPlain(body.length);
  return tokens;
}

function findBeforeNewline(body: string, needle: string, from: number): number {
  const close = body.indexOf(needle, from);
  if (close === -1) return -1;
  const newline = body.indexOf("\n", from);
  return newline !== -1 && newline < close ? -1 : close;
}

/**
 * Emphasis content must be non-empty, stay on one line, and hug its markers:
 * `* spaced *` is prose, `2 * 3 * 4` is arithmetic, neither is emphasis.
 */
function matchEmphasis(
  body: string,
  index: number,
  marker: "*" | "**",
): { content: string; end: number } | null {
  const contentStart = index + marker.length;
  if (/\s|\*/.test(body[contentStart] ?? " ")) return null;
  let close = body.indexOf(marker, contentStart + 1);
  while (close !== -1) {
    const content = body.slice(contentStart, close);
    if (content.includes("\n")) return null;
    if (!/\s/.test(body[close - 1]!)) return { content, end: close + marker.length };
    close = body.indexOf(marker, close + 1);
  }
  return null;
}

function trimAutolink(url: string): string {
  let trimmed = url.replace(AUTOLINK_TRAILING, "");
  while (trimmed.endsWith(")") && !hasBalancedParens(trimmed)) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

function hasBalancedParens(url: string): boolean {
  let depth = 0;
  for (const char of url) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
  }
  return depth >= 0;
}
