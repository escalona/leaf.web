import { AppTitleBar } from "../../ui/app/AppTitleBar";
import { LoadingScreen } from "../../ui/app/LoadingScreen";
import { readDisplayError } from "../../core/shared/errors";

/**
 * No document is involved at this point: the tree is restoring a session or
 * building the runtime, so the title says which rather than promising one.
 */
export function LoadingState({ title = "Loading Leaf…" }: { title?: string }) {
  return <LoadingScreen title={title} />;
}

export function ErrorState({
  error,
  onRetry,
  onBackToHome,
  backLabel = "Back to home",
  title = "Failed to load document",
}: {
  error: unknown;
  onRetry: () => void;
  onBackToHome: () => void;
  backLabel?: string;
  title?: string;
}) {
  const detail = readDisplayError(error, "An unknown error occurred while loading.");

  return (
    <LoadingScreen
      title={title}
      detail={detail}
      action={
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button
            type="button"
            onClick={onRetry}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "1px solid #18181b",
              backgroundColor: "#18181b",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onBackToHome}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "1px solid #e4e4e7",
              backgroundColor: "#fff",
              color: "#18181b",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {backLabel}
          </button>
        </div>
      }
    />
  );
}

export function AuthConfigErrorState({ error }: { error: unknown }) {
  const detail = readDisplayError(error, "Unable to load the WorkOS login configuration.");

  return <LoadingScreen title="Sign in is unavailable" detail={detail} />;
}

export function SignOnScreen({
  error,
  onSignIn,
  onSignUp,
  onUseLocally,
}: {
  error: string | null;
  onSignIn: () => void;
  onSignUp: () => void;
  onUseLocally: () => void;
}) {
  return (
    <div
      style={{
        width: "100vw",
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        backgroundColor: "#fafafa",
        color: "#18181b",
        fontFamily: "Inter, system-ui, sans-serif",
        padding: 24,
      }}
    >
      <AppTitleBar />
      <main
        aria-label="Sign in"
        style={{
          width: "min(100%, 360px)",
          display: "grid",
          gap: 14,
          padding: 28,
          border: "1px solid #e4e4e7",
          borderRadius: 8,
          backgroundColor: "#fff",
          boxShadow: "0 20px 50px rgba(24, 24, 27, 0.08)",
        }}
      >
        <div>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: 0 }}>Leaf</div>
          <div style={{ marginTop: 8, color: "#71717a", fontSize: 14 }}>
            Sign in to sync your files across devices.
          </div>
        </div>
        {error ? (
          <div style={{ color: "#b91c1c", fontSize: 13, lineHeight: 1.4 }}>{error}</div>
        ) : null}
        <button
          type="button"
          onClick={onSignIn}
          style={{
            minHeight: 40,
            borderRadius: 8,
            border: "1px solid #18181b",
            backgroundColor: "#18181b",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={onSignUp}
          style={{
            minHeight: 40,
            borderRadius: 8,
            border: "1px solid #e4e4e7",
            backgroundColor: "#fff",
            color: "#18181b",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Create account
        </button>
        <div style={{ display: "grid", gap: 4, justifyItems: "center" }}>
          <button
            type="button"
            onClick={onUseLocally}
            style={{
              minHeight: 32,
              padding: "0 8px",
              borderRadius: 8,
              border: "none",
              backgroundColor: "transparent",
              color: "#3f3f46",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Use Leaf locally
          </button>
          <div style={{ color: "#a1a1aa", fontSize: 12, lineHeight: 1.4, textAlign: "center" }}>
            Design without an account. Files stay on this device.
          </div>
        </div>
      </main>
    </div>
  );
}

// Drop any selected-document hash and reload so a fresh bootstrap lands on the
// home dashboard instead of immediately retrying a document that may have failed
// to load before auth or the local sync server was ready.
export function returnToHome() {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  window.location.reload();
}
