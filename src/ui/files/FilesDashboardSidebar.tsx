import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ClockIcon, CloseIcon, FolderOpenIcon } from "../icons";
import { cx } from "../primitives/cx";
import type { FilesDashboardView } from "./files-dashboard-model";

export type FilesDashboardAuthUser = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
};

export function getAccountDisplayName(user: FilesDashboardAuthUser | null | undefined) {
  if (!user) return "Account";

  const fullName = [user.firstName, user.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  return fullName || user.email;
}

export function getAccountInitial(user: FilesDashboardAuthUser | null | undefined) {
  const displayName = getAccountDisplayName(user);
  return displayName.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? "A";
}

function AccountButton({
  authUser,
  onSignIn,
  onSignOut,
}: {
  authUser?: FilesDashboardAuthUser | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Local mode has no account, so the same menu offers the way back in.
  const isLocal = Boolean(!authUser && onSignIn);
  const displayName = isLocal ? "Local" : getAccountDisplayName(authUser);
  const initial = isLocal ? "L" : getAccountInitial(authUser);
  const canSignOut = Boolean(authUser && onSignOut);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const handleSignOut = () => {
    setOpen(false);
    onSignOut?.();
  };

  const handleSignIn = () => {
    setOpen(false);
    onSignIn?.();
  };

  return (
    <div ref={rootRef} className="relative mb-3">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "flex w-full items-center gap-2.5 rounded-md border-none px-2.5 py-1.5 text-left text-[14px] font-normal text-ink",
          open ? "bg-[#e9e9eb]" : "bg-transparent hover:bg-surface-sunken",
        )}
      >
        <div className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-[#089383] text-xs font-bold text-white">
          {authUser?.profilePictureUrl ? (
            <img alt="" src={authUser.profilePictureUrl} className="h-full w-full object-cover" />
          ) : (
            initial
          )}
        </div>
        <span className="min-w-0 flex-1 truncate">{displayName}</span>
        <ChevronDownIcon
          size={12}
          className={cx("text-ink-muted transition-transform duration-100", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-[calc(100%+6px)] left-0 z-20 w-[220px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-edge-strong bg-surface text-ink shadow-[0_18px_42px_rgba(24,24,27,0.14)]"
        >
          <div className="px-4 py-3">
            <div className="text-[14px] leading-snug text-ink-muted">
              {isLocal ? "Working locally" : "Signed in as"}
            </div>
            <div className="mt-1 truncate text-[14px] leading-snug">
              {isLocal ? "Files stay on this device" : (authUser?.email ?? displayName)}
            </div>
          </div>
          <div className="h-px bg-edge" />
          {isLocal ? (
            <button
              type="button"
              role="menuitem"
              onClick={handleSignIn}
              className="flex w-full items-center border-none bg-transparent px-4 py-3 text-left text-[14px] leading-snug text-ink-secondary transition-colors hover:bg-surface-sunken"
            >
              Sign in
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={!canSignOut}
              onClick={handleSignOut}
              className={cx(
                "flex w-full items-center border-none bg-transparent px-4 py-3 text-left text-[14px] leading-snug",
                canSignOut ? "text-ink-secondary hover:bg-surface-sunken" : "text-ink-faint",
              )}
            >
              Log out
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SidebarNavButton({
  active,
  icon,
  label,
  onSelect,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-md border-none px-3 py-2 text-left text-sm font-medium",
        active
          ? "bg-surface-sunken text-ink"
          : "bg-transparent text-ink-secondary hover:bg-surface-sunken/60 hover:text-ink",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SidebarContent({
  activeView,
  authUser,
  onClose,
  onSignIn,
  onSignOut,
  onViewChange,
}: {
  activeView: FilesDashboardView;
  authUser?: FilesDashboardAuthUser | null;
  onClose?: () => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  onViewChange: (view: FilesDashboardView) => void;
}) {
  const selectView = (view: FilesDashboardView) => {
    onViewChange(view);
    onClose?.();
  };
  return (
    <>
      {onClose ? (
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-[6px] border-none bg-transparent text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </div>
      ) : null}
      {/* A local-only build has no account and no sign-in to offer, so the
          menu would only say "Account" with a dead "Log out". Show it when
          there is a signed-in user or a way to sign in (hosted local mode). */}
      {authUser || onSignIn ? (
        <AccountButton authUser={authUser} onSignIn={onSignIn} onSignOut={onSignOut} />
      ) : null}
      <SidebarNavButton
        active={activeView === "recents"}
        icon={<ClockIcon size={16} />}
        label="Recents"
        onSelect={() => selectView("recents")}
      />
      <SidebarNavButton
        active={activeView === "files"}
        icon={<FolderOpenIcon size={16} />}
        label="Files"
        onSelect={() => selectView("files")}
      />
    </>
  );
}

export function FilesDashboardSidebar({
  activeView,
  authUser,
  onSignIn,
  onSignOut,
  onViewChange,
}: {
  activeView: FilesDashboardView;
  authUser?: FilesDashboardAuthUser | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
  onViewChange: (view: FilesDashboardView) => void;
}) {
  return (
    <aside className="flex flex-col gap-1 border-r border-edge bg-surface px-3 py-4">
      <SidebarContent
        activeView={activeView}
        authUser={authUser}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
        onViewChange={onViewChange}
      />
    </aside>
  );
}

export function MobileFilesDashboardSidebar({
  activeView,
  authUser,
  onClose,
  onSignIn,
  onSignOut,
  onViewChange,
}: {
  activeView: FilesDashboardView;
  authUser?: FilesDashboardAuthUser | null;
  onClose: () => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  onViewChange: (view: FilesDashboardView) => void;
}) {
  return (
    <div
      // The overlay covers the window's title-bar drag strip; opt the whole
      // surface out of dragging so the backdrop and drawer receive clicks.
      className="app-no-drag fixed inset-0 z-40 flex"
    >
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 border-none bg-black/30 p-0"
      />
      <aside className="relative z-1 flex w-[260px] flex-col gap-1 border-r border-edge bg-surface px-3 py-4">
        <SidebarContent
          activeView={activeView}
          authUser={authUser}
          onClose={onClose}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          onViewChange={onViewChange}
        />
      </aside>
    </div>
  );
}
