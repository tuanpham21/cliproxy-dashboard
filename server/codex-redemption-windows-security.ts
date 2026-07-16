import { execFile } from "node:child_process";

export type WindowsAclCommandRunner = (
  binary: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

export type WindowsPrivatePathSecurity = {
  secureCreatedDirectory(path: string): Promise<void>;
  verifyPrivatePath(path: string, requireProtected: boolean): Promise<void>;
};

type WindowsPrivatePathSecurityDependencies = {
  runCommand?: WindowsAclCommandRunner;
};

const CURRENT_USER_TIMEOUT_MS = 5_000;
const ICACLS_TIMEOUT_MS = 10_000;
const SYSTEM_SID = "S-1-5-18";
const FILE_SYSTEM_FULL_CONTROL = 0x1f01ff;
const INHERITED_ACE = 0x10;
const INHERIT_ONLY_ACE = 0x08;
const PATH_SECURITY_SCRIPT = `& {
  param([string]$LiteralPath)
  $ErrorActionPreference = 'Stop'
  $acl = Get-Acl -LiteralPath $LiteralPath
  $owner = $acl.Owner
  try {
    $sid = ([System.Security.Principal.NTAccount]::new($owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $sid = ([System.Security.Principal.SecurityIdentifier]::new($owner)).Value
  }
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  $aces = @($descriptor.DiscretionaryAcl | ForEach-Object {
    $knownAce = $_ -is [System.Security.AccessControl.KnownAce]
    [pscustomobject]@{
      aceType = $_.AceType.ToString()
      aceFlags = [int]$_.AceFlags
      accessMask = if ($knownAce) { [int64]$_.AccessMask } else { -1 }
      sid = if ($knownAce) { $_.SecurityIdentifier.Value } else { $null }
    }
  })
  [Console]::Out.Write(([pscustomobject]@{
    ownerSid = $sid
    daclProtected = ($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
    aces = $aces
  } | ConvertTo-Json -Depth 4 -Compress))
}`;

export class WindowsPrivatePathSecurityError extends Error {
  constructor() {
    super("Windows private path privacy unavailable.");
    this.name = "WindowsPrivatePathSecurityError";
  }
}

function defaultRunCommand(binary: string, args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });
}

function parseCurrentUserSid(stdout: string): string {
  const sid = stdout.match(/S-1-(?:\d+-)+\d+/i)?.[0];
  if (!sid) throw new WindowsPrivatePathSecurityError();
  return sid.toUpperCase();
}

type PathSecurityAce = { aceType: string; aceFlags: number; accessMask: number; sid: string };
type PathSecurityEvidence = { ownerSid: string; daclProtected: boolean; aces: PathSecurityAce[] };

function normalizeSid(value: string): string {
  if (!/^S-1-(?:\d+-)+\d+$/i.test(value)) throw new WindowsPrivatePathSecurityError();
  return value.toUpperCase();
}

function parsePathSecurityEvidence(stdout: string): PathSecurityEvidence {
  try {
    const parsed = JSON.parse(stdout) as { ownerSid?: unknown; daclProtected?: unknown; aces?: unknown };
    if (
      typeof parsed.ownerSid !== "string" || typeof parsed.daclProtected !== "boolean" ||
      !Array.isArray(parsed.aces) || parsed.aces.length === 0 || parsed.aces.length > 64
    ) {
      throw new WindowsPrivatePathSecurityError();
    }
    const aces = parsed.aces.map((raw): PathSecurityAce => {
      const ace = raw as Partial<PathSecurityAce>;
      if (
        typeof ace.aceType !== "string" || typeof ace.aceFlags !== "number" ||
        !Number.isSafeInteger(ace.aceFlags) || typeof ace.accessMask !== "number" ||
        !Number.isSafeInteger(ace.accessMask) || typeof ace.sid !== "string"
      ) {
        throw new WindowsPrivatePathSecurityError();
      }
      return { aceType: ace.aceType, aceFlags: ace.aceFlags, accessMask: ace.accessMask, sid: normalizeSid(ace.sid) };
    });
    return { ownerSid: normalizeSid(parsed.ownerSid), daclProtected: parsed.daclProtected, aces };
  } catch (error) {
    if (error instanceof WindowsPrivatePathSecurityError) throw error;
    throw new WindowsPrivatePathSecurityError();
  }
}

function verifyPathSecurityEvidence(
  evidence: PathSecurityEvidence,
  currentUserSid: string,
  requireProtected: boolean,
): void {
  if (requireProtected && !evidence.daclProtected) throw new WindowsPrivatePathSecurityError();
  const allowedSids = new Set([currentUserSid, SYSTEM_SID]);
  let currentUserHasFullControl = false;
  for (const ace of evidence.aces) {
    if (ace.aceType !== "AccessAllowed" || !allowedSids.has(ace.sid)) throw new WindowsPrivatePathSecurityError();
    if (requireProtected && (ace.aceFlags & INHERITED_ACE) !== 0) throw new WindowsPrivatePathSecurityError();
    if (
      ace.sid === currentUserSid && ace.accessMask === FILE_SYSTEM_FULL_CONTROL &&
      (ace.aceFlags & INHERIT_ONLY_ACE) === 0
    ) currentUserHasFullControl = true;
  }
  if (!currentUserHasFullControl) throw new WindowsPrivatePathSecurityError();
}

export function createWindowsPrivatePathSecurity(
  dependencies: WindowsPrivatePathSecurityDependencies = {},
): WindowsPrivatePathSecurity {
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  let currentUserSidPromise: Promise<string> | null = null;

  const currentUserSid = async (): Promise<string> => {
    currentUserSidPromise ??= runCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"], CURRENT_USER_TIMEOUT_MS)
      .then((result) => parseCurrentUserSid(result.stdout));
    return await currentUserSidPromise;
  };

  const verifyPrivatePath = async (targetPath: string, requireProtected: boolean): Promise<void> => {
    const sid = await currentUserSid();
    try {
      const result = await runCommand("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        PATH_SECURITY_SCRIPT,
        targetPath,
      ], CURRENT_USER_TIMEOUT_MS);
      const evidence = parsePathSecurityEvidence(result.stdout);
      if (evidence.ownerSid !== sid) throw new WindowsPrivatePathSecurityError();
      verifyPathSecurityEvidence(evidence, sid, requireProtected);
    } catch (error) {
      if (error instanceof WindowsPrivatePathSecurityError) throw error;
      throw new WindowsPrivatePathSecurityError();
    }
  };

  return {
    async secureCreatedDirectory(targetPath: string): Promise<void> {
      const sid = await currentUserSid();
      try {
        await runCommand("icacls.exe", [targetPath, "/reset", "/c", "/q"], ICACLS_TIMEOUT_MS);
        await runCommand("icacls.exe", [
          targetPath,
          "/inheritance:r",
          "/grant:r",
          `*${sid}:(OI)(CI)F`,
          `*${SYSTEM_SID}:(OI)(CI)F`,
          "/c",
          "/q",
        ], ICACLS_TIMEOUT_MS);
        await verifyPrivatePath(targetPath, true);
      } catch (error) {
        if (error instanceof WindowsPrivatePathSecurityError) throw error;
        throw new WindowsPrivatePathSecurityError();
      }
    },
    verifyPrivatePath,
  };
}
