import os from "node:os";
import path from "node:path";
import process from "node:process";

import { isRegistryProfileId } from "./codex-login-profile-registry-migration.js";
import { resolveFixedRoot } from "./codex-redemption-private-owner.js";
import type { WindowsPrivatePathSecurity } from "./codex-redemption-windows-security.js";

type PrivateRedemptionStateLocationInput = Readonly<{
  profileId?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  rootPathForTests?: string;
  rootAnchorForTests?: string;
  windowsLocalApplicationData?: () => string;
}>;

export type PrivateRedemptionStateLocation = Readonly<{
  rootPath: string;
  rootAnchorPath: string;
  resolutionFailed: boolean;
  retryResolution: (() => { rootPath: string; rootAnchorPath: string }) | null;
}>;

export function profileStateRoot(baseRoot: string, profileId?: string): string {
  if (profileId === undefined) return baseRoot;
  if (!isRegistryProfileId(profileId)) throw new Error("Invalid Codex Login Profile binding.");
  return path.join(baseRoot, "profiles", profileId);
}

export function privateRedemptionRootContext(
  platform: NodeJS.Platform,
  rootPath: string,
  rootAnchorPath: string,
  windowsSecurity?: WindowsPrivatePathSecurity,
) {
  return { platform, rootPath, rootAnchorPath, windowsSecurity };
}

export function resolvePrivateRedemptionStateLocation(
  input: PrivateRedemptionStateLocationInput,
): PrivateRedemptionStateLocation {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir;
  const home = homedir();
  const resolveBaseRoot = () => resolveFixedRoot(platform, env, homedir, input.windowsLocalApplicationData);
  const rootAnchor = (baseRoot: string) => input.rootAnchorForTests
    ?? (platform === "linux" && env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : platform === "win32" && !input.rootPathForTests
        ? path.win32.dirname(path.win32.dirname(baseRoot))
        : home);
  const location = (baseRoot: string) => ({
    rootPath: profileStateRoot(baseRoot, input.profileId),
    rootAnchorPath: rootAnchor(baseRoot),
  });

  if (input.rootPathForTests !== undefined) {
    return { ...location(input.rootPathForTests), resolutionFailed: false, retryResolution: null };
  }
  try {
    const baseRoot = resolveBaseRoot();
    return {
      ...location(baseRoot),
      resolutionFailed: false,
      retryResolution: platform === "win32" ? () => location(resolveBaseRoot()) : null,
    };
  } catch {
    const unavailableRoot = path.join(home, ".cliproxy-dashboard-private-state-unavailable");
    return {
      ...location(unavailableRoot),
      resolutionFailed: true,
      retryResolution: platform === "win32" ? () => location(resolveBaseRoot()) : null,
    };
  }
}
