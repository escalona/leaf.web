/**
 * Renders Leaf markup as React elements — never as HTML strings, so a body
 * can only ever produce the fixed element set below no matter what it says.
 *
 * `interactive` distinguishes reading surfaces from preview surfaces: rows
 * and hover cards that are themselves clickable render links as styled text
 * so a click means "open the thread", never "leave the app".
 */
import type { CSSProperties, ReactNode } from "react";
import { parseMarkup, type MarkupToken } from "./tokenize";

export function MarkupText({
  body,
  interactive = true,
  resolveMentionLabel,
}: {
  body: string;
  interactive?: boolean;
  /** Live display name for a mention; the stored label is only a snapshot. */
  resolveMentionLabel?: (actorId: string, fallback: string) => string;
}) {
  return <>{renderTokens(parseMarkup(body), { interactive, resolveMentionLabel })}</>;
}

type RenderContext = {
  interactive: boolean;
  resolveMentionLabel?: (actorId: string, fallback: string) => string;
};

function renderTokens(tokens: MarkupToken[], context: RenderContext): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "text":
        return <span key={index}>{token.text}</span>;
      case "code":
        return (
          <code key={index} style={CODE_STYLE}>
            {token.text}
          </code>
        );
      case "link":
        return context.interactive ? (
          <a
            key={index}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            style={LINK_STYLE}
            onClick={(event) => event.stopPropagation()}
          >
            {token.text}
          </a>
        ) : (
          <span key={index} style={LINK_STYLE}>
            {token.text}
          </span>
        );
      case "mention":
        return (
          <span key={index} style={MENTION_CHIP_STYLE}>
            @{context.resolveMentionLabel?.(token.actorId, token.label) ?? token.label}
          </span>
        );
      case "strong":
        return <strong key={index}>{renderTokens(token.children, context)}</strong>;
      case "em":
        return <em key={index}>{renderTokens(token.children, context)}</em>;
    }
  });
}

const CODE_STYLE: CSSProperties = {
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: "0.92em",
  background: "var(--leaf-surface-sunken)",
  border: "1px solid var(--leaf-border)",
  borderRadius: 4,
  padding: "0 3px",
};

const LINK_STYLE: CSSProperties = {
  color: "var(--leaf-accent)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  overflowWrap: "anywhere",
};

const MENTION_CHIP_STYLE: CSSProperties = {
  color: "var(--leaf-accent)",
  background: "var(--leaf-accent-soft)",
  borderRadius: 4,
  padding: "0 3px",
  fontWeight: 600,
  whiteSpace: "nowrap",
};
