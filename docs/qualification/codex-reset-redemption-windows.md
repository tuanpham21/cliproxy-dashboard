# Windows Codex reset-redemption qualification

Status: prepared, not yet executed on authoritative Windows dashboard host.

This packet qualifies issue #16 without consuming a Usage Limit Reset Credit. Run only on actual Windows host that will run dashboard. Keep raw evidence outside repository under current-user-private DACL. Never call any route ending in `/consume`.

## 1. Set authoritative inputs

Open PowerShell on target host as normal dashboard user.

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repo = "$env:USERPROFILE\Workspace\personal\cliproxy-dashboard"
$BaseUri = "http://127.0.0.1:60948"
$Port = 60948
$CodexBin = (Get-Command codex.exe -ErrorAction Stop).Source
$CodexHomeInput = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$CodexHome = (Resolve-Path -LiteralPath $CodexHomeInput -ErrorAction Stop).Path
$env:CODEX_HOME = $CodexHome
$ExpectedCommit = "<paste committed #16 SHA>"
$LocalApplicationData = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::LocalApplicationData,
  [Environment+SpecialFolderOption]::DoNotVerify
)
if ([string]::IsNullOrWhiteSpace($LocalApplicationData) -or $LocalApplicationData.StartsWith("\\")) {
  throw "OS LocalApplicationData known folder unavailable."
}

Set-Location -LiteralPath $Repo
$NodeVersion = [version]((node --version).Trim().TrimStart("v").Split("-")[0])
if ($NodeVersion -lt [version]"22.13.0") { throw "Node 22.13.0 or newer required." }
if (!(Test-Path -LiteralPath $CodexBin -PathType Leaf)) { throw "Configured codex.exe missing." }

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$EvidenceRoot = Join-Path $LocalApplicationData "cliproxy-dashboard\qualification-evidence\$Stamp"
New-Item -ItemType Directory -Path $EvidenceRoot -ErrorAction Stop | Out-Null

$CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $EvidenceRoot /reset /c /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Evidence DACL reset failed." }
& icacls.exe $EvidenceRoot /inheritance:r /grant:r `
  "*${CurrentSid}:(OI)(CI)F" `
  "*S-1-5-18:(OI)(CI)F" `
  /c /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Evidence DACL application failed." }

$EvidenceAcl = Get-Acl -LiteralPath $EvidenceRoot
if (!$EvidenceAcl.AreAccessRulesProtected) { throw "Evidence DACL inheritance remains enabled." }

$BinaryRecorded = $false
$SchemaPassed = $false
$TargetedTestsPassed = $false
$CumulativeValidationPassed = $false
$LoopbackPassed = $false
$GatewayPassed = $false
$CsrfPassed = $false
$DaclPassed = $false
$HiddenChildCleanupPassed = $false
$SpacePathsPassed = $false
$ConsumeGuardPassed = $false
```

Do not commit `$EvidenceRoot`. Do not paste raw SID, username-bearing paths, account email, credit IDs, quota values, or provider bodies into GitHub.

## 2. Record host, commit, binary, version, file identity

```powershell
$CodexItem = Get-Item -LiteralPath $CodexBin
$CodexVersion = (& $CodexBin --version | Select-Object -First 1).Trim()
$CodexHash = (Get-FileHash -LiteralPath $CodexBin -Algorithm SHA256).Hash.ToLowerInvariant()
$Commit = (git rev-parse HEAD).Trim()
$Branch = (git branch --show-current).Trim()
if ($ExpectedCommit -notmatch "^[a-f0-9]{7,40}$" -or !$Commit.StartsWith($ExpectedCommit)) {
  throw "Checkout is not at expected committed #16 revision."
}
$FeaturePaths = @(
  "docs/qualification/codex-reset-redemption-windows.md",
  "frontend/src/codex-app-account.test.ts",
  "frontend/src/codex-app-account.ts",
  "frontend/e2e/codex-app-account.spec.ts",
  "server/codex-app-account-usage.ts",
  "server/codex-app-server-client.ts",
  "server/codex-redemption-consume.ts",
  "server/codex-redemption-private-digests.ts",
  "server/codex-redemption-private-files.ts",
  "server/codex-redemption-private-filesystem.ts",
  "server/codex-redemption-private-owner.ts",
  "server/codex-redemption-private-root.ts",
  "server/codex-redemption-private-state.ts",
  "server/codex-redemption-recovery-coordinator.ts",
  "server/codex-redemption-service.ts",
  "server/codex-redemption-terminal-recovery.ts",
  "server/codex-redemption-windows-security.ts",
  "server/codex-runtime-executable.ts",
  "server/codex-runtime-qualifier.ts",
  "server/codex-state-privacy.ts",
  "server/test"
)
$FeatureDirty = @(git status --porcelain -- @FeaturePaths)
if ($FeatureDirty.Count -ne 0) { throw "Committed #16 feature paths are dirty." }

[pscustomobject]@{
  captured_at_utc = (Get-Date).ToUniversalTime().ToString("o")
  windows = [System.Environment]::OSVersion.VersionString
  node = (node --version).Trim()
  pnpm = (pnpm --version).Trim()
  commit = $Commit
  branch = $Branch
  codex_canonical_path_private = $CodexItem.FullName
  codex_home_private = $CodexHome
  codex_canonical_path_sha256 = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($CodexItem.FullName))) -Algorithm SHA256).Hash.ToLowerInvariant()
  codex_version = $CodexVersion
  codex_binary_sha256 = $CodexHash
  current_user_sid_recorded_privately = $true
  consume_calls = 0
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EvidenceRoot "host-manifest.private.json") -Encoding utf8
$BinaryRecorded = $true
```

Configured dashboard launch must use this exact `$CodexBin` through `--codex-bin` or matching `CODEX_BIN`.

## 3. Generate and hash stable schema with exact binary

```powershell
$SchemaRoot = Join-Path $EvidenceRoot "stable app-server schema"
New-Item -ItemType Directory -Path $SchemaRoot -Force | Out-Null
& icacls.exe $SchemaRoot /inheritance:r /grant:r `
  "*${CurrentSid}:(OI)(CI)F" `
  "*S-1-5-18:(OI)(CI)F" `
  /c /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Schema evidence DACL failed." }

& $CodexBin app-server generate-json-schema --out $SchemaRoot
if ($LASTEXITCODE -ne 0) { throw "Stable schema generation failed." }

$RequiredSchemas = @(
  "ClientRequest.json",
  "v2\GetAccountResponse.json",
  "v2\GetAccountRateLimitsResponse.json",
  "v2\ConsumeAccountRateLimitResetCreditParams.json",
  "v2\ConsumeAccountRateLimitResetCreditResponse.json"
)
foreach ($Relative in $RequiredSchemas) {
  if (!(Test-Path -LiteralPath (Join-Path $SchemaRoot $Relative) -PathType Leaf)) {
    throw "Required schema missing: $Relative"
  }
}

$SchemaManifest = Get-ChildItem -LiteralPath $SchemaRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
  [pscustomobject]@{
    relative_path = $_.FullName.Substring($SchemaRoot.Length).TrimStart("\")
    bytes = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$SchemaManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EvidenceRoot "schema-manifest.json") -Encoding utf8
$SchemaPassed = $true
```

Schema generation is local contract inspection. It does not call reset-credit consume.

## 4. Run automated Windows regressions and cumulative validation

```powershell
Set-Location -LiteralPath $Repo
Get-Command pnpm -ErrorAction Stop | Out-Null
pnpm install --frozen-lockfile

pnpm exec vitest run `
  server/test/codex-redemption-windows-security.test.ts `
  server/test/codex-redemption-private-owner.test.ts `
  server/test/codex-redemption-private-filesystem.test.ts `
  server/test/codex-redemption-private-process.test.ts `
  server/test/codex-redemption-private-state.test.ts `
  server/test/codex-redemption-recovery-state.test.ts `
  server/test/codex-redemption-recovery.test.ts `
  server/test/codex-redemption-terminal-recovery.test.ts `
  server/test/codex-runtime-qualifier.test.ts `
  server/test/codex-app-server-client.test.ts `
  server/test/codex-redemption-api.test.ts `
  server/test/codex-app-account-usage.test.ts `
  frontend/src/codex-app-account.test.ts `
  2>&1 | Tee-Object -FilePath (Join-Path $EvidenceRoot "targeted-tests.txt")
if ($LASTEXITCODE -ne 0) { throw "Targeted Windows regressions failed." }
$TargetedTestsPassed = $true

pnpm run typecheck 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceRoot "typecheck.txt")
if ($LASTEXITCODE -ne 0) { throw "Typecheck failed." }
pnpm run test 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceRoot "unit-tests.txt")
if ($LASTEXITCODE -ne 0) { throw "Unit/integration tests failed." }
pnpm run test:browser 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceRoot "browser-tests.txt")
if ($LASTEXITCODE -ne 0) { throw "Browser tests failed." }
pnpm run build 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceRoot "build.txt")
if ($LASTEXITCODE -ne 0) { throw "Production build failed." }
$CumulativeValidationPassed = $true
```

Targeted regressions cover SID/DACL parsing, shared `CODEX_HOME` rejection, hard-link no-overwrite, rename/cleanup, Windows directory-sync capability, real process-start identity, PID mismatch, cross-process exclusion, path spaces, hidden child options, direct-child cleanup failure, loopback, Origin, Host, and operator token.

## 5. Start exact loopback dashboard

Use existing target-host CLIProxy paths. Do not bind wildcard/LAN address.

```powershell
$DashboardJob = $null
$SpaceDashboardJob = $null
$DashboardJobIdentity = $null
$SpaceDashboardJobIdentity = $null
$DashboardListenerOwners = @()
$SpaceDashboardListenerOwners = @()
$SpacePort = $Port + 1
$DashboardJobIdentityPath = Join-Path $EvidenceRoot "dashboard-job.private.json"
$SpaceDashboardJobIdentityPath = Join-Path $EvidenceRoot "space-dashboard-job.private.json"

function Assert-PortUnbound([int]$ListenerPort) {
  if (Get-NetTCPConnection -State Listen -LocalPort $ListenerPort -ErrorAction SilentlyContinue) {
    throw "Qualification port $ListenerPort is already bound. Stop the existing listener or choose new ports."
  }
}

function Wait-QualificationJobIdentity($Job, [string]$IdentityPath) {
  $Deadline = (Get-Date).AddSeconds(10)
  $Identity = $null
  do {
    $JobState = (Get-Job -Id $Job.Id -ErrorAction Stop).State
    if ($JobState -in @("Failed", "Completed", "Stopped", "Disconnected")) {
      throw "Dashboard job exited before recording process identity: $JobState`n$(Receive-Job -Job $Job | Out-String)"
    }
    if (Test-Path -LiteralPath $IdentityPath -PathType Leaf) {
      try {
        $Candidate = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json
        $CandidateId = [int]$Candidate.Id
        $CandidateStartTicks = [int64]$Candidate.StartTicks
        if ($CandidateId -gt 0 -and $CandidateStartTicks -gt 0) {
          $Identity = [pscustomobject]@{ Id = $CandidateId; StartTicks = $CandidateStartTicks }
        }
      } catch {
        $Identity = $null
      }
    }
    if ($null -eq $Identity) { Start-Sleep -Milliseconds 100 }
  } until ($null -ne $Identity -or (Get-Date) -ge $Deadline)
  if ($null -eq $Identity) { throw "Dashboard job process identity missing." }
  $Current = Get-Process -Id $Identity.Id -ErrorAction Stop
  if ($Current.StartTime.ToUniversalTime().Ticks -ne $Identity.StartTicks) {
    throw "Dashboard job process identity changed before listener qualification."
  }
  return $Identity
}

function Assert-ProcessDescendants([object[]]$Owners, $AncestorIdentity) {
  $AncestorProcess = Get-Process -Id $AncestorIdentity.Id -ErrorAction Stop
  if ($AncestorProcess.StartTime.ToUniversalTime().Ticks -ne $AncestorIdentity.StartTicks) {
    throw "Expected ancestor process identity changed before provenance check."
  }
  $ProcessSnapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $ById = @{}
  foreach ($SnapshotProcess in $ProcessSnapshot) {
    $ById[[int]$SnapshotProcess.ProcessId] = $SnapshotProcess
  }
  foreach ($Owner in $Owners) {
    $ListenerProcess = Get-Process -Id $Owner.Id -ErrorAction Stop
    if ($ListenerProcess.StartTime.ToUniversalTime().Ticks -ne $Owner.StartTicks) {
      throw "Listener process identity changed during provenance check."
    }
    $Seen = @{}
    $CurrentProcessId = [int]$Owner.Id
    $Proven = $false
    for ($Depth = 0; $Depth -lt 64; $Depth++) {
      if ($Seen.ContainsKey($CurrentProcessId)) { break }
      $Seen[$CurrentProcessId] = $true
      if ($CurrentProcessId -eq [int]$AncestorIdentity.Id) {
        $Proven = $true
        break
      }
      if (!$ById.ContainsKey($CurrentProcessId)) { break }
      $ParentProcessId = [int]$ById[$CurrentProcessId].ParentProcessId
      if ($ParentProcessId -le 0 -or $ParentProcessId -eq $CurrentProcessId) { break }
      $CurrentProcessId = $ParentProcessId
    }
    if (!$Proven) {
      throw "Process $($Owner.Id) is not a proven descendant of process $($AncestorIdentity.Id)."
    }
  }
}

function Get-ListenerOwners($Connections) {
  return @($Connections.OwningProcess | Sort-Object -Unique | ForEach-Object {
    $Process = Get-Process -Id $_ -ErrorAction Stop
    [pscustomobject]@{ Id = $Process.Id; StartTicks = $Process.StartTime.ToUniversalTime().Ticks }
  })
}

function Stop-QualificationJob($Job, [object[]]$ExpectedOwners, [int]$ListenerPort, [string]$LogPath) {
  $Output = ""
  $JobCleanupError = $null
  try {
    if ($null -ne $Job) {
      $RegisteredJob = Get-Job -Id $Job.Id -ErrorAction SilentlyContinue
      if ($null -ne $RegisteredJob) {
        if ($RegisteredJob.State -notin @("Completed", "Failed", "Stopped")) {
          Stop-Job -Job $RegisteredJob -ErrorAction Stop
        }
        $Output = Receive-Job -Job $RegisteredJob -ErrorAction SilentlyContinue 2>&1 | Out-String
        $Output | Set-Content -LiteralPath $LogPath -Encoding utf8
        Remove-Job -Job $RegisteredJob -ErrorAction Stop
      }
    }
  } catch {
    $JobCleanupError = $_
  }
  Start-Sleep -Milliseconds 500
  $SurvivorPids = @(Get-NetTCPConnection -State Listen -LocalPort $ListenerPort -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($ListenerProcessId in $SurvivorPids) {
    $Expected = @($ExpectedOwners | Where-Object { $_.Id -eq $ListenerProcessId })
    $Current = Get-Process -Id $ListenerProcessId -ErrorAction SilentlyContinue
    if ($Expected.Count -ne 1 -or $null -eq $Current -or
      $Current.StartTime.ToUniversalTime().Ticks -ne $Expected[0].StartTicks) {
      throw "Unexpected listener survived qualification cleanup on port $ListenerPort."
    }
    Stop-Process -Id $ListenerProcessId -Force -ErrorAction Stop
  }
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -State Listen -LocalPort $ListenerPort -ErrorAction SilentlyContinue) {
    throw "Qualification listener survived cleanup on port $ListenerPort."
  }
  if ($null -ne $JobCleanupError) { throw $JobCleanupError }
  return $Output
}

function Stop-AllQualificationJobs {
  $CleanupErrors = @()
  if ($null -ne $SpaceDashboardJob) {
    try {
      $null = Stop-QualificationJob $SpaceDashboardJob $SpaceDashboardListenerOwners $SpacePort `
        (Join-Path $EvidenceRoot "space-dashboard.private.log")
    } catch { $CleanupErrors += $_.Exception.Message }
  }
  if ($null -ne $DashboardJob) {
    try {
      $null = Stop-QualificationJob $DashboardJob $DashboardListenerOwners $Port `
        (Join-Path $EvidenceRoot "dashboard.private.log")
    } catch { $CleanupErrors += $_.Exception.Message }
  }
  if ($CleanupErrors.Count -ne 0) { throw ($CleanupErrors -join [Environment]::NewLine) }
}

Assert-PortUnbound $Port
Assert-PortUnbound $SpacePort

try {
$DashboardArguments = @(
  "run", "start", "--",
  "--host", "127.0.0.1",
  "--port", [string]$Port,
  "--no-port-fallback",
  "--codex-bin", $CodexBin,
  "--cli-proxy-bin", "C:\Tools\cli-proxy-api\cli-proxy-api.exe",
  "--config", "$env:USERPROFILE\.config\cli-proxy-api\config.yaml",
  "--auth-dir", "$env:USERPROFILE\.cli-proxy-api",
  "--backup-root", "$env:USERPROFILE\.cli-proxy-api-backups\cliproxy-dashboard"
)
$DashboardArgumentsJson = $DashboardArguments | ConvertTo-Json -Compress
$DashboardJob = Start-Job -ScriptBlock {
  param(
    [string]$WorkingDirectory,
    [string]$LaunchArgumentsJson,
    [string]$PinnedCodexHome,
    [string]$JobIdentityPath
  )
  $env:CODEX_HOME = $PinnedCodexHome
  $Self = Get-Process -Id $PID -ErrorAction Stop
  [pscustomobject]@{
    Id = $Self.Id
    StartTicks = $Self.StartTime.ToUniversalTime().Ticks
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $JobIdentityPath -Encoding utf8
  Set-Location -LiteralPath $WorkingDirectory
  $LaunchArguments = @($LaunchArgumentsJson | ConvertFrom-Json)
  & pnpm @LaunchArguments
  if ($LASTEXITCODE -ne 0) { throw "Dashboard process exited with code $LASTEXITCODE." }
} -ArgumentList $Repo, $DashboardArgumentsJson, $CodexHome, $DashboardJobIdentityPath
$DashboardJobIdentity = Wait-QualificationJobIdentity $DashboardJob $DashboardJobIdentityPath

$ListenerDeadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 250
  $DashboardState = (Get-Job -Id $DashboardJob.Id).State
  if ($DashboardState -in @("Failed", "Completed", "Stopped", "Disconnected")) {
    throw "Dashboard job exited before listener readiness: $DashboardState`n$(Receive-Job -Job $DashboardJob | Out-String)"
  }
  $Listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
} until ($Listeners -or (Get-Date) -ge $ListenerDeadline)
if (!$Listeners) { throw "Dashboard listener missing." }
$DashboardListenerCandidates = Get-ListenerOwners $Listeners
Assert-ProcessDescendants $DashboardListenerCandidates $DashboardJobIdentity
$DashboardListenerOwners = $DashboardListenerCandidates
if ($DashboardListenerOwners.Count -ne 1) { throw "Expected one dashboard listener process owner." }
$NonLoopback = $Listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }
if ($NonLoopback) { throw "Dashboard has non-loopback listener." }
$Listeners | Select-Object LocalAddress,LocalPort,OwningProcess |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot "listener.private.json") -Encoding utf8
$LoopbackPassed = $true
} catch { Stop-AllQualificationJobs; throw }
```

## 6. Prove read-only gateway calls and CSRF boundaries

```powershell
try {
$BaseHeaders = @{
  Origin = $BaseUri
  "Sec-Fetch-Site" = "same-origin"
}
$Bootstrap = Invoke-RestMethod -Method Get -Uri "$BaseUri/api/bootstrap" -Headers $BaseHeaders
if ([string]::IsNullOrWhiteSpace($Bootstrap.operatorToken)) { throw "Bootstrap token missing." }
$AuthorizedHeaders = @{
  Origin = $BaseUri
  "Sec-Fetch-Site" = "same-origin"
  "x-cliproxy-dashboard-token" = $Bootstrap.operatorToken
}
$Usage = Invoke-RestMethod -Method Get -Uri "$BaseUri/api/codex/account-usage" -Headers $AuthorizedHeaders
if ($Usage.runtime.status -ne "qualified") { throw "Exact Codex runtime did not qualify." }
if ($null -eq $Usage.account -or [string]::IsNullOrWhiteSpace($Usage.account.email)) { throw "account/read identity missing." }
if ($null -eq $Usage.usage) { throw "account/rateLimits/read usage missing." }

[pscustomobject]@{
  state = $Usage.state
  runtime_status = $Usage.runtime.status
  runtime_version = $Usage.runtime.version
  account_read_succeeded = ($null -ne $Usage.account)
  account_email_present = ![string]::IsNullOrWhiteSpace($Usage.account.email)
  rate_limits_read_succeeded = ($null -ne $Usage.usage)
  reset_summary_present = ($null -ne $Usage.resetCredits)
  raw_account_values_archived = $false
  consume_calls = 0
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot "gateway-summary.redacted.json") -Encoding utf8
$GatewayPassed = $true

function Get-HttpStatus([string]$Uri, [hashtable]$Headers) {
  try {
    return [int](Invoke-WebRequest -UseBasicParsing -Method Get -Uri $Uri -Headers $Headers).StatusCode
  } catch {
    return [int]$_.Exception.Response.StatusCode
  }
}

$MissingTokenStatus = Get-HttpStatus "$BaseUri/api/codex/account-usage" $BaseHeaders
$BadOriginStatus = Get-HttpStatus "$BaseUri/api/codex/account-usage" @{
  Origin = "http://attacker.invalid"
  "Sec-Fetch-Site" = "same-origin"
  "x-cliproxy-dashboard-token" = $Bootstrap.operatorToken
}
$GoodStatus = Get-HttpStatus "$BaseUri/api/codex/account-usage" $AuthorizedHeaders
if ($MissingTokenStatus -ne 403 -or $BadOriginStatus -ne 403 -or $GoodStatus -ne 200) {
  throw "Origin/operator-token qualification failed."
}
$CsrfPassed = $true
} catch { Stop-AllQualificationJobs; throw }
```

Do not query `POST /api/codex/reset-redemptions/.../consume`.

## 7. Prove production recovery-root and `CODEX_HOME` DACLs

Before opening confirmation, capture process and tombstone baselines:

```powershell
try {
$Before = @(Get-Process codex -ErrorAction SilentlyContinue |
  Select-Object Id,StartTime,Path,MainWindowHandle)
$BeforeKeys = @($Before | ForEach-Object { "$($_.Id)|$($_.StartTime.ToUniversalTime().Ticks)" })
$RecoveryRoot = Join-Path $LocalApplicationData "cliproxy-dashboard\codex-reset-redemption"
$TombstonesBefore = if (Test-Path -LiteralPath $RecoveryRoot) {
  @(Get-ChildItem -LiteralPath $RecoveryRoot -File -Filter "tombstone.*.json" | ForEach-Object Name)
} else { @() }
$Before | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot "codex-processes-before.private.json") -Encoding utf8
} catch { Stop-AllQualificationJobs; throw }
```

In browser, open **Review reset** confirmation only. Do not activate **Redeem reset**. Keep dialog open through DACL and live-child checks.

```powershell
try {
function Assert-PrivateAcl([string]$LiteralPath, [bool]$RequireProtected) {
  if (!(Test-Path -LiteralPath $LiteralPath)) { throw "Private path missing." }
  $Acl = Get-Acl -LiteralPath $LiteralPath
  if ($RequireProtected -and !$Acl.AreAccessRulesProtected) { throw "DACL inheritance is not protected." }
  $OwnerSid = $Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($OwnerSid -ne $CurrentSid) { throw "Private path owner is not current user SID." }
  $Allowed = @($CurrentSid, "S-1-5-18")
  $Rules = $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  $Unexpected = $Rules | Where-Object {
    $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    $_.IdentityReference.Value -notin $Allowed
  }
  if ($Unexpected) { throw "Unexpected or broad DACL principal found." }
  $CurrentFull = $Rules | Where-Object {
    $_.IdentityReference.Value -eq $CurrentSid -and
    ($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
    ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
      [System.Security.AccessControl.FileSystemRights]::FullControl
  }
  if (!$CurrentFull) { throw "Current user lacks FullControl." }
}

function Assert-NoReparseAncestry([string]$LiteralPath, [string]$TrustedRoot) {
  if ((Get-Item -LiteralPath $TrustedRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Current-user profile is a reparse point."
  }
  $Root = (Resolve-Path -LiteralPath $TrustedRoot -ErrorAction Stop).Path.TrimEnd("\")
  $Target = (Resolve-Path -LiteralPath $LiteralPath -ErrorAction Stop).Path
  if ($Target -ne $Root -and !$Target.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Private path is outside current-user profile."
  }
  $Current = $Root
  $Relative = $Target.Substring($Root.Length).TrimStart("\")
  foreach ($Segment in @($Relative.Split("\", [StringSplitOptions]::RemoveEmptyEntries))) {
    $Current = Join-Path $Current $Segment
    if ((Get-Item -LiteralPath $Current).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Private path contains a reparse-point ancestor."
    }
  }
}

Assert-NoReparseAncestry $CodexHome $env:USERPROFILE
Assert-PrivateAcl $RecoveryRoot $true
Assert-PrivateAcl $CodexHome $false
Get-ChildItem -LiteralPath $RecoveryRoot -File | ForEach-Object { Assert-PrivateAcl $_.FullName $false }

$AclDump = Join-Path $EvidenceRoot "recovery-acl.private.txt"
& icacls.exe $RecoveryRoot /save $AclDump /t /c /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls recovery verification failed." }
(Get-Acl -LiteralPath $RecoveryRoot).Sddl |
  Set-Content -LiteralPath (Join-Path $EvidenceRoot "recovery-root-sddl.private.txt") -Encoding utf8
(Get-Acl -LiteralPath $CodexHome).Sddl |
  Set-Content -LiteralPath (Join-Path $EvidenceRoot "codex-home-sddl.private.txt") -Encoding utf8
$DaclPassed = $true
} catch { Stop-AllQualificationJobs; throw }
```

Keep confirmation open. Continue directly to section 8.

## 8. Hidden child cleanup and executable path-with-spaces sentinels

With **Review reset** still open, capture live Codex child:

```powershell
try {
$During = @(Get-Process codex -ErrorAction SilentlyContinue |
  Select-Object Id,StartTime,Path,MainWindowHandle)
$DuringKeys = @($During | ForEach-Object { "$($_.Id)|$($_.StartTime.ToUniversalTime().Ticks)" })
$NewDuring = @($During | Where-Object {
  "$($_.Id)|$($_.StartTime.ToUniversalTime().Ticks)" -notin $BeforeKeys
})
if ($NewDuring.Count -ne 1) { throw "Expected exactly one live proposal app-server child." }
if ($NewDuring[0].MainWindowHandle -ne 0) { throw "Proposal app-server child has a visible window." }
if ((Get-FileHash -LiteralPath $NewDuring[0].Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $CodexHash) {
  throw "Proposal app-server child does not use authoritative Codex binary bytes."
}
$CodexCandidateOwners = @([pscustomobject]@{
  Id = $NewDuring[0].Id
  StartTicks = $NewDuring[0].StartTime.ToUniversalTime().Ticks
})
Assert-ProcessDescendants $CodexCandidateOwners $DashboardListenerOwners[0]
$NewDuring | Select-Object Id,StartTime,Path,MainWindowHandle,@{
  Name = "process_start_identity"; Expression = { $_.StartTime.ToUniversalTime().Ticks.ToString() }
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot "codex-process-live.private.json") -Encoding utf8
} catch { Stop-AllQualificationJobs; throw }
```

Choose **Cancel**, wait two seconds, then prove same PID/start identities are gone and no consume state appeared:

```powershell
try {
Start-Sleep -Seconds 2
$After = @(Get-Process codex -ErrorAction SilentlyContinue |
  Select-Object Id,StartTime,Path,MainWindowHandle)
$AfterKeys = @($After | ForEach-Object { "$($_.Id)|$($_.StartTime.ToUniversalTime().Ticks)" })
$After | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot "codex-processes-after.private.json") -Encoding utf8
$SurvivingProposalChildren = @($NewDuring | Where-Object {
  "$($_.Id)|$($_.StartTime.ToUniversalTime().Ticks)" -in $AfterKeys
})
if ($SurvivingProposalChildren.Count -ne 0) { throw "Codex child survived cancellation." }
if (Test-Path -LiteralPath (Join-Path $RecoveryRoot "active-redemption.json")) {
  throw "Active redemption state remains after cancellation."
}
$TombstonesAfter = @(Get-ChildItem -LiteralPath $RecoveryRoot -File -Filter "tombstone.*.json" -ErrorAction SilentlyContinue |
  ForEach-Object Name)
$NewTombstones = @($TombstonesAfter | Where-Object { $_ -notin $TombstonesBefore })
if ($NewTombstones.Count -ne 0) { throw "Terminal redemption tombstone appeared during read-only qualification." }
$HiddenChildCleanupPassed = $true
} catch { Stop-AllQualificationJobs; throw }
```

Run target-host space-path probe. This creates an NTFS hard link to authoritative Codex bytes and a junction to dashboard checkout; it starts a second loopback-only, read-only dashboard on a different port.

```powershell
try {
$SpaceProbeRoot = Join-Path $EvidenceRoot "path with spaces probe"
New-Item -ItemType Directory -Path $SpaceProbeRoot -Force | Out-Null
& icacls.exe $SpaceProbeRoot /inheritance:r /grant:r `
  "*${CurrentSid}:(OI)(CI)F" `
  "*S-1-5-18:(OI)(CI)F" `
  /c /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Space-probe DACL failed." }

$SpaceCodexDir = Join-Path $SpaceProbeRoot "Codex Binary"
New-Item -ItemType Directory -Path $SpaceCodexDir -Force | Out-Null
$SpaceCodexBin = Join-Path $SpaceCodexDir "codex.exe"
New-Item -ItemType HardLink -Path $SpaceCodexBin -Target $CodexBin | Out-Null
if ((Get-FileHash -LiteralPath $SpaceCodexBin -Algorithm SHA256).Hash.ToLowerInvariant() -ne $CodexHash) {
  throw "Space-path Codex hard link changed binary bytes."
}
if ((& $SpaceCodexBin --version | Select-Object -First 1).Trim() -ne $CodexVersion) {
  throw "Space-path Codex version mismatch."
}
$SpaceSchemaRoot = Join-Path $SpaceProbeRoot "Schema Output"
& $SpaceCodexBin app-server generate-json-schema --out $SpaceSchemaRoot
if ($LASTEXITCODE -ne 0) { throw "Space-path schema generation failed." }
foreach ($Relative in $RequiredSchemas) {
  if (!(Test-Path -LiteralPath (Join-Path $SpaceSchemaRoot $Relative) -PathType Leaf)) {
    throw "Space-path required schema missing: $Relative"
  }
}

$SpaceDashboardPath = Join-Path $SpaceProbeRoot "Dashboard Checkout"
New-Item -ItemType Junction -Path $SpaceDashboardPath -Target $Repo | Out-Null
$SpaceBaseUri = "http://127.0.0.1:$SpacePort"
$SpaceArguments = @($DashboardArguments)
$SpacePortIndex = [Array]::IndexOf($SpaceArguments, [string]$Port)
$SpaceCodexIndex = [Array]::IndexOf($SpaceArguments, $CodexBin)
if ($SpacePortIndex -lt 0 -or $SpaceCodexIndex -lt 0) { throw "Space-path launch argument rewrite failed." }
$SpaceArguments[$SpacePortIndex] = [string]$SpacePort
$SpaceArguments[$SpaceCodexIndex] = $SpaceCodexBin
$SpaceArgumentsJson = $SpaceArguments | ConvertTo-Json -Compress
Assert-PortUnbound $SpacePort
$SpaceDashboardJob = Start-Job -ScriptBlock {
  param(
    [string]$WorkingDirectory,
    [string]$LaunchArgumentsJson,
    [string]$PinnedCodexHome,
    [string]$JobIdentityPath
  )
  $env:CODEX_HOME = $PinnedCodexHome
  $Self = Get-Process -Id $PID -ErrorAction Stop
  [pscustomobject]@{
    Id = $Self.Id
    StartTicks = $Self.StartTime.ToUniversalTime().Ticks
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $JobIdentityPath -Encoding utf8
  Set-Location -LiteralPath $WorkingDirectory
  $LaunchArguments = @($LaunchArgumentsJson | ConvertFrom-Json)
  & pnpm @LaunchArguments
  if ($LASTEXITCODE -ne 0) { throw "Space-path dashboard exited with code $LASTEXITCODE." }
} -ArgumentList $SpaceDashboardPath, $SpaceArgumentsJson, $CodexHome, $SpaceDashboardJobIdentityPath
$SpaceDashboardJobIdentity = Wait-QualificationJobIdentity $SpaceDashboardJob $SpaceDashboardJobIdentityPath

$SpaceDeadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 250
  $SpaceDashboardState = (Get-Job -Id $SpaceDashboardJob.Id).State
  if ($SpaceDashboardState -in @("Failed", "Completed", "Stopped", "Disconnected")) {
    throw "Space-path dashboard exited before listener readiness: $SpaceDashboardState`n$(Receive-Job -Job $SpaceDashboardJob | Out-String)"
  }
  $SpaceListener = Get-NetTCPConnection -State Listen -LocalPort $SpacePort -ErrorAction SilentlyContinue
} until ($SpaceListener -or (Get-Date) -ge $SpaceDeadline)
if (!$SpaceListener) { throw "Space-path dashboard listener missing." }
$SpaceDashboardListenerCandidates = Get-ListenerOwners $SpaceListener
Assert-ProcessDescendants $SpaceDashboardListenerCandidates $SpaceDashboardJobIdentity
$SpaceDashboardListenerOwners = $SpaceDashboardListenerCandidates
if ($SpaceDashboardListenerOwners.Count -ne 1) { throw "Expected one space-path listener process owner." }
$SpaceNonLoopback = @($SpaceListener | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })
if ($SpaceNonLoopback.Count -ne 0) {
  throw "Space-path dashboard did not bind loopback-only."
}
$SpaceHeaders = @{ Origin = $SpaceBaseUri; "Sec-Fetch-Site" = "same-origin" }
$SpaceBootstrap = Invoke-RestMethod -Method Get -Uri "$SpaceBaseUri/api/bootstrap" -Headers $SpaceHeaders
$SpaceHeaders["x-cliproxy-dashboard-token"] = $SpaceBootstrap.operatorToken
$SpaceUsage = Invoke-RestMethod -Method Get -Uri "$SpaceBaseUri/api/codex/account-usage" -Headers $SpaceHeaders
if ($SpaceUsage.runtime.status -ne "qualified" -or $SpaceUsage.runtime.version -ne $CodexVersion) {
  throw "Space-path dashboard/gateway qualification failed."
}
$null = Stop-QualificationJob $SpaceDashboardJob $SpaceDashboardListenerOwners $SpacePort `
  (Join-Path $EvidenceRoot "space-dashboard.private.log")
$SpaceDashboardJob = $null
$SpacePathsPassed = $true
} catch { Stop-AllQualificationJobs; throw }
```

## 9. Sanitized completion manifest

Only after every command passes:

```powershell
$DashboardOutput = Stop-QualificationJob $DashboardJob $DashboardListenerOwners $Port `
  (Join-Path $EvidenceRoot "dashboard.private.log")
$DashboardJob = $null
if ($DashboardOutput -match '"event":"codex_redemption_terminal"') {
  throw "Redemption audit event appeared during read-only qualification."
}
$ConsumeGuardPassed = $true

$RequiredChecks = @(
  $BinaryRecorded,
  $SchemaPassed,
  $TargetedTestsPassed,
  $CumulativeValidationPassed,
  $LoopbackPassed,
  $GatewayPassed,
  $CsrfPassed,
  $DaclPassed,
  $HiddenChildCleanupPassed,
  $SpacePathsPassed,
  $ConsumeGuardPassed
)
if ($RequiredChecks -contains $false) { throw "Qualification has incomplete checks." }

[pscustomobject]@{
  issue = 16
  commit = $Commit
  host_qualification = "passed_read_only"
  exact_binary_version_recorded = $BinaryRecorded
  exact_binary_schema_recorded = $SchemaPassed
  gateway_account_read = $GatewayPassed
  gateway_rate_limits_read = $GatewayPassed
  recovery_dacl = $DaclPassed
  codex_home_dacl = $DaclPassed
  hard_link_no_overwrite = $TargetedTestsPassed
  atomic_rename_cleanup = $TargetedTestsPassed
  process_start_identity = $TargetedTestsPassed
  pid_mismatch_regression = $TargetedTestsPassed
  cross_process_exclusion = $TargetedTestsPassed
  paths_with_spaces = $SpacePathsPassed
  hidden_child_cleanup = $HiddenChildCleanupPassed
  loopback_listener = $LoopbackPassed
  csrf_negative_checks = $CsrfPassed
  typecheck = if ($CumulativeValidationPassed) { "passed" } else { "failed" }
  unit_tests = if ($CumulativeValidationPassed) { "passed" } else { "failed" }
  browser_tests = if ($CumulativeValidationPassed) { "passed" } else { "failed" }
  build = if ($CumulativeValidationPassed) { "passed" } else { "failed" }
  consume_calls = if ($ConsumeGuardPassed) { 0 } else { $null }
  provider_mutation = !$ConsumeGuardPassed
  raw_private_values_committed = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot "qualification-summary.sanitized.json") -Encoding utf8
```

Commit only sanitized summary and schema hashes if Human explicitly requests publication. Keep raw evidence private. Qualification remains incomplete until target-host output is reviewed against this checklist.
