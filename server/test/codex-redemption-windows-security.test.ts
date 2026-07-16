import { chmod, mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createWindowsPrivatePathSecurity,
  type WindowsAclCommandRunner,
} from "../codex-redemption-windows-security.js";
import { resolveCodexStateRoot, verifyCodexStateRoot } from "../codex-state-privacy.js";
import { makeTempRoot } from "./helpers.js";

const USER_SID = "S-1-5-21-111-222-333-1001";
const SYSTEM_SID = "S-1-5-18";
const FULL_CONTROL = 0x1f01ff;

type TestAce = { aceType: string; aceFlags: number; accessMask: number; sid: string };

function allow(sid: string, aceFlags = 0, accessMask = FULL_CONTROL): TestAce {
  return { aceType: "AccessAllowed", aceFlags, accessMask, sid };
}

function privateAcl(overrides: {
  ownerSid?: string;
  daclProtected?: boolean;
  aces?: TestAce[];
} = {}) {
  return {
    ownerSid: overrides.ownerSid ?? USER_SID,
    daclProtected: overrides.daclProtected ?? true,
    aces: overrides.aces ?? [allow(USER_SID), allow(SYSTEM_SID)],
  };
}

function securityHarness(
  evidence: unknown = privateAcl(),
) {
  const calls: Array<{ binary: string; args: string[]; timeoutMs: number }> = [];
  const runCommand: WindowsAclCommandRunner = vi.fn(async (binary, args, timeoutMs) => {
    calls.push({ binary, args, timeoutMs });
    return {
      stdout: binary === "whoami.exe"
        ? `"DESKTOP\\operator","${USER_SID}"\r\n`
        : binary === "powershell.exe"
          ? JSON.stringify(evidence)
          : "",
    };
  });
  const security = createWindowsPrivatePathSecurity({ runCommand });
  return { security, calls };
}

describe("Windows private-path security", () => {
  it("applies a protected DACL and verifies structured ACE evidence without a replaceable temp file", async () => {
    const { security, calls } = securityHarness();
    const root = "C:\\Users\\Operator Name\\AppData\\Local\\cliproxy-dashboard\\codex-reset-redemption";

    await security.secureCreatedDirectory(root);

    expect(calls).toEqual([
      { binary: "whoami.exe", args: ["/user", "/fo", "csv", "/nh"], timeoutMs: 5_000 },
      { binary: "icacls.exe", args: [root, "/reset", "/c", "/q"], timeoutMs: 10_000 },
      {
        binary: "icacls.exe",
        args: [
          root,
          "/inheritance:r",
          "/grant:r",
          `*${USER_SID}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
          "/c",
          "/q",
        ],
        timeoutMs: 10_000,
      },
      {
        binary: "powershell.exe",
        args: expect.arrayContaining(["-NoLogo", "-NoProfile", "-NonInteractive", root]),
        timeoutMs: 5_000,
      },
    ]);
  });

  it("rejects broad principals, missing current-user access, malformed dumps, and unprotected recovery roots", async () => {
    const cases = [
      privateAcl({ aces: [allow(USER_SID), allow(SYSTEM_SID), allow("S-1-5-32-545")] }),
      privateAcl({ aces: [allow(USER_SID), allow(SYSTEM_SID), allow("S-1-5-32-544")] }),
      privateAcl({ aces: [allow(USER_SID, 0x08), allow(SYSTEM_SID)] }),
      privateAcl({ aces: [allow(SYSTEM_SID)] }),
      { ownerSid: USER_SID, daclProtected: true, aces: "malformed" },
      privateAcl({ daclProtected: false }),
    ];
    for (const evidence of cases) {
      const { security } = securityHarness(evidence);
      await expect(security.verifyPrivatePath("C:\\private", true)).rejects.toThrow(
        "Windows private path privacy unavailable.",
      );
    }
    const { security: wrongOwner } = securityHarness(privateAcl({ ownerSid: "S-1-5-21-111-222-333-1002" }));
    await expect(wrongOwner.verifyPrivatePath("C:\\private", true)).rejects.toThrow(
      "Windows private path privacy unavailable.",
    );
  });

  it("allows inherited file ACLs only when every ACE remains current-user or SYSTEM", async () => {
    const { security } = securityHarness(privateAcl({
      daclProtected: false,
      aces: [allow(USER_SID, 0x10), allow(SYSTEM_SID, 0x10)],
    }));
    await expect(security.verifyPrivatePath("C:\\private\\active-redemption.json", false)).resolves.toBeUndefined();
  });

  it("collects only the discretionary ACL and never parses SACL text in Node", async () => {
    const { security, calls } = securityHarness();

    await expect(security.verifyPrivatePath("C:\\private", true)).resolves.toBeUndefined();
    const inspectionScript = calls.find((call) => call.binary === "powershell.exe")?.args[6] ?? "";
    expect(inspectionScript).toContain("DiscretionaryAcl");
    expect(inspectionScript).not.toContain("SystemAcl");
  });

  it("rejects a broad callback ACE whose condition contains an SDDL section marker", async () => {
    const { security } = securityHarness(privateAcl({
      aces: [
        allow(USER_SID),
        allow(SYSTEM_SID),
        { aceType: "AccessAllowedCallback", aceFlags: 0, accessMask: FULL_CONTROL, sid: "S-1-5-32-545" },
      ],
    }));

    await expect(security.verifyPrivatePath("C:\\private", true)).rejects.toThrow(
      "Windows private path privacy unavailable.",
    );
  });
});

describe("Codex state privacy", () => {
  it("resolves Windows CODEX_HOME without shell expansion and rejects relative overrides", () => {
    expect(resolveCodexStateRoot("win32", { CODEX_HOME: "C:\\Users\\Operator Name\\Codex State" }, () => "ignored"))
      .toBe("C:\\Users\\Operator Name\\Codex State");
    expect(() => resolveCodexStateRoot("win32", { CODEX_HOME: "shared\\codex" }, () => "C:\\Users\\Operator Name"))
      .toThrow("Codex state privacy unavailable.");
    expect(resolveCodexStateRoot("win32", {}, () => "C:\\Users\\Operator Name"))
      .toBe("C:\\Users\\Operator Name\\.codex");
  });

  it("requires private POSIX ownership and delegates Windows effective-DACL verification", async () => {
    const parent = await makeTempRoot();
    const codexHome = path.join(parent, "Codex State With Spaces");
    await mkdir(codexHome, { mode: 0o700 });
    await chmod(codexHome, 0o700);

    const canonicalCodexHome = await realpath(codexHome);
    if (process.platform !== "win32") {
      await expect(verifyCodexStateRoot({
        platform: "darwin",
        env: { CODEX_HOME: codexHome },
        homedir: () => parent,
      })).resolves.toBe(canonicalCodexHome);

      await chmod(codexHome, 0o755);
      await expect(verifyCodexStateRoot({
        platform: "darwin",
        env: { CODEX_HOME: codexHome },
        homedir: () => parent,
      })).rejects.toThrow("Codex state privacy unavailable.");
    }

    const verifyPrivatePath = vi.fn(async () => {});
    await expect(verifyCodexStateRoot({
      platform: "win32",
      env: {},
      homedir: () => parent,
      codexStateRootForTests: codexHome,
      windowsSecurity: { secureCreatedDirectory: vi.fn(), verifyPrivatePath },
    })).resolves.toBe(canonicalCodexHome);
    expect(verifyPrivatePath).toHaveBeenCalledWith(codexHome, false);
  });

  it("rejects a Codex state root reached through a symlinked ancestor", async () => {
    const parent = await makeTempRoot();
    const actual = path.join(parent, "actual");
    const linked = path.join(parent, "linked");
    const codexHome = path.join(actual, "Codex State");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await symlink(actual, linked);

    await expect(verifyCodexStateRoot({
      platform: "darwin",
      env: { CODEX_HOME: path.join(linked, "Codex State") },
      homedir: () => parent,
    })).rejects.toThrow("Codex state privacy unavailable.");
  });
});
