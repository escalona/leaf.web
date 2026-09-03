import type { ReactNode } from "react";
import type { AppHost } from "../app-host";
import { AppBootstrap, type RuntimeFetcher } from "./app-bootstrap";
import { AuthConfigErrorState } from "./boot-states";
import { resolveStandardBoot, type StandardBoot } from "./standard-boot";

/**
 * The boot arms the browser and desktop trees share. A config error, dev auth,
 * and the local-only build mount `AppBootstrap` the same way on both; only the
 * account arm differs, because each tree signs in through its own auth
 * surface, so the caller renders that one.
 */
export function StandardRoot({
  fetcher,
  host,
  renderAccount,
}: {
  fetcher?: RuntimeFetcher;
  host?: AppHost;
  renderAccount: (boot: Extract<StandardBoot, { kind: "account" }>) => ReactNode;
}) {
  const boot = resolveStandardBoot();
  switch (boot.kind) {
    case "config-error":
      return <AuthConfigErrorState error={boot.error} />;
    case "dev":
      return (
        <AppBootstrap
          accountId={boot.accountId}
          authUser={boot.authUser}
          fetcher={fetcher}
          getAccessToken={boot.getAccessToken}
          host={host}
        />
      );
    case "local":
      // The local-only build: no account to offer, so an empty workspace
      // lands in the editor rather than on a dashboard with one button.
      // `App` keeps desktop windows on their own launch path.
      return (
        <AppBootstrap accountId={boot.accountId} autoOpenFirstFile fetcher={fetcher} host={host} />
      );
    case "account":
      return renderAccount(boot);
  }
}
