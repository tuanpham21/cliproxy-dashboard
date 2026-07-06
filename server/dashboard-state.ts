import path from "node:path";

import { publicAccount, readAccounts } from "./accounts.js";
import { publicConfig, readConfig } from "./config.js";
import { readLatestCodexSelection, readLogSummary } from "./logs.js";
import { publicDashboardPaths, resolveDashboardPaths } from "./paths.js";
import { readProxyModels } from "./proxy-models.js";
import { readMergedQuotaSnapshots } from "./quota-log-updates.js";
import type { DashboardOptions, DashboardState } from "./types.js";
import { normalizeProxyAccountLocalIdentity, toPublicQuotaSnapshot } from "./util.js";

export async function readDashboardState(options: DashboardOptions = {}): Promise<DashboardState> {
  const paths = await resolveDashboardPaths(options);
  const [config, accountsResult, modelsResult, logSummary, latestCodexSelectionFromLogs] =
    await Promise.all([
      readConfig(paths.configPath),
      readAccounts(paths.authDir),
      readProxyModels(paths.proxyUrl, paths.inboundKey),
      readLogSummary(paths.mainLogPath),
      readLatestCodexSelection(paths.logsDir),
    ]);
  const quotaSnapshots = await readMergedQuotaSnapshots(
    paths,
    accountsResult.accounts,
    options.beforeQuotaSnapshotStateWrite,
  );
  const latestCodexSelection =
    latestCodexSelectionFromLogs ??
    (logSummary.latestSelection?.auth?.startsWith("codex-")
      ? {
          timestamp: logSummary.latestSelection.timestamp,
          auth: logSummary.latestSelection.auth,
          provider: logSummary.latestSelection.provider,
          raw: logSummary.latestSelection.raw,
          fileName: path.basename(logSummary.latestSelection.auth),
          label: "",
          type: "",
        }
      : null);
  const selectedAccount = latestCodexSelection
    ? (accountsResult.accounts.find(
        (account) =>
          normalizeProxyAccountLocalIdentity(account.fileName) ===
          normalizeProxyAccountLocalIdentity(path.basename(latestCodexSelection.auth)),
      ) ?? null)
    : null;

  const accountsMapped = accountsResult.accounts.map((account) => {
    return {
      ...publicAccount(
        account,
        toPublicQuotaSnapshot(
          quotaSnapshots.snapshotsByCanonicalIdentity.get(
            normalizeProxyAccountLocalIdentity(account.fileName),
          ),
        ),
      ),
    };
  });
  const selectedAccountMapped = selectedAccount
    ? publicAccount(
        selectedAccount,
        toPublicQuotaSnapshot(
          quotaSnapshots.snapshotsByCanonicalIdentity.get(
            normalizeProxyAccountLocalIdentity(selectedAccount.fileName),
          ),
        ),
      )
    : null;

  return {
    paths: publicDashboardPaths(paths),
    config: publicConfig(config),
    accounts: accountsMapped,
    selectedAccount: selectedAccountMapped,
    models: modelsResult.models,
    logSummary: {
      ...logSummary,
      latestCodexSelection,
    },
    errors: [
        ...(config ? [] : [`Could not read proxy config at ${paths.configPath}`]),
        ...accountsResult.errors,
        ...modelsResult.errors,
        ...quotaSnapshots.errors,
        ...(logSummary.latestRequest || logSummary.latestSelection || latestCodexSelection
          ? []
          : [`No recent proxy logs found at ${paths.mainLogPath}`]),
    ],
    lastRefreshedAt: new Date().toISOString(),
  };
}
