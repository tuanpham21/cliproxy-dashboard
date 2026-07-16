import type { PrivateRedemptionStateStoreDependencies } from "../codex-redemption-private-state.js";

export const PRIVATE_STATE_TEST_PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "darwin";

const windowsSecurity: NonNullable<PrivateRedemptionStateStoreDependencies["windowsSecurity"]> = {
  secureCreatedDirectory: async () => {},
  verifyPrivatePath: async () => {},
};

export function privateStatePlatformDependencies(): Pick<
  PrivateRedemptionStateStoreDependencies,
  "platform" | "windowsSecurity"
> {
  return {
    platform: PRIVATE_STATE_TEST_PLATFORM,
    windowsSecurity: PRIVATE_STATE_TEST_PLATFORM === "win32" ? windowsSecurity : undefined,
  };
}
