# Cliproxy Dashboard 🚀

A premium, state-of-the-art web dashboard built in **TypeScript** to manage local Codex accounts, configure proxy routing, monitor service logs, and handle automatic session verification and reauthentication.

Designed with a cozy, high-contrast warm color palette (cozy chocolate-amber charcoal and peach-tinted light mode), custom terminal panels, and pulsing state animations. Fully compliant with modern accessibility standards and the **Vercel Web Interface Guidelines**.

---

## Key Features 🎨

### 1. 🔑 Account Management & Browser OAuth
* **Instant Login**: Launch Google/OpenAI OAuth flows directly from the browser. Employs `login_hint` to pre-populate correct user emails.
* **JSON Import**: Quick import/import-fallback by pasting credentials JSON configuration files directly.
* **Flexible Priorities**: Adjust priorities per account dynamically to balance the load.

### 2. ⚡ Real-Time Status Verification
* **Auto-refresh**: Sequentially verifies account token validity against OpenAI API endpoints, automatically refreshing expired sessions via OAuth refresh tokens when available.
* **Bulk Check**: Verify all configured accounts sequentially with a real-time progress indicator.
* **Pulsing Indicators**: Status lights show active state:
  - 🟢 **Valid**: Active session.
  - 🔴 **Session ended**: Expired session (hover to see the detailed validation error).
  - ⚪ **Unverified**: Status not yet checked.

### 3. 🛠️ Configurable Routing Strategies
* **Strategy Selection**: Easily switch routing algorithms (`fill-first` or `failover`).
* **Session Affinity**: Toggle session affinity to bind specific sessions to identical Codex accounts.
* **Automatic Daemon Management**: Stuck callback instances are cleaned up automatically upon initiating fresh logins to prevent port binding conflicts.

### 4. 💻 ProMax Developer UX/UI
* **Cozy Dual Themes**: Floating header switch supporting high-contrast Warm Dark and Light modes.
* **Mac-style Terminal Consoles**: Logs and outputs are embedded in sleek window layouts containing titlebars, scrollbars, and macOS window control dots.
* **Typographic Perfection**: Enforced tabular numerals for index/priority alignment and proper ellipsis formatting (`…`).

---

## Tech Stack 🛠️

* **Frontend**: Plain Vite + TypeScript under `frontend/`
* **Server**: Node.js HTTP Server (`src/cliproxy-dashboard.ts`) with implementation modules under `src/server/`
* **Styling**: Vanilla CSS (no Tailwind required)
* **Build System**: TypeScript (`tsc`) plus Vite (`vite build`)
* **Test Runner**: Vitest (`src/test/*.test.ts`, `frontend/src/*.test.ts`)

---

## Directory Structure 📂

```
cliproxy-dashboard/
├── dist/
│   ├── cliproxy-dashboard.js       # Built server entry used by LaunchAgent/start
│   └── frontend/                   # Built Vite frontend assets
├── frontend/
│   ├── index.html                  # Vite HTML shell
│   ├── vite.config.ts              # Frontend dev/build config
│   └── src/                        # Browser TypeScript and CSS
├── src/
│   ├── cliproxy-dashboard.ts       # Stable server entry and export surface
│   ├── server/                     # Server/API/state/quota/log modules
│   └── test/                       # Vitest server tests and helpers
├── tsconfig.json        # TypeScript configuration compiler options
├── package.json         # Scripts, dependencies, and devDependencies
└── .gitignore           # File/folder exclusion list
```

---

## Getting Started 🚀

### Prerequisites
* **Node.js**: `v20` or higher
* **Go CLI Proxy**: Install `cli-proxy-api.exe` and pass it with `--cli-proxy-bin`, or set `CLI_PROXY_API_BIN`.

Windows migration paths:

```text
C:\Tools\cli-proxy-api\cli-proxy-api.exe
%USERPROFILE%\.config\cli-proxy-api\config.yaml
%USERPROFILE%\.cli-proxy-api
%USERPROFILE%\.cli-proxy-api-backups\cliproxy-dashboard
```

### Installation
Clone the repository and install dependencies:
```powershell
cd "$env:USERPROFILE\Workspace\personal\cliproxy-dashboard"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

### Scripts

* **Start the Vite Frontend in Development Mode**:
  ```powershell
  pnpm run dev
  ```
  Run `pnpm run dev:server` in another shell for the Node API that Vite proxies to.
* **Build the Codebase**:
  ```powershell
  pnpm run build
  ```
* **Build Only the Server or Frontend**:
  ```powershell
  pnpm run build:server
  pnpm run build:frontend
  ```
* **Type Check**:
  ```powershell
  pnpm run typecheck
  ```
* **Run the Test Suite**:
  ```powershell
  pnpm run test
  ```
* **Start Server**:
  ```powershell
  pnpm run start
  ```

### Windows Loopback Run

Use explicit Windows paths and keep the dashboard on loopback:

```powershell
$CliProxyBin = "C:\Tools\cli-proxy-api\cli-proxy-api.exe"
if (!(Test-Path $CliProxyBin)) {
  throw "Missing cli-proxy-api.exe at $CliProxyBin"
}

pnpm run start -- `
  --host 127.0.0.1 `
  --port 60948 `
  --cli-proxy-bin $CliProxyBin `
  --config "$env:USERPROFILE\.config\cli-proxy-api\config.yaml" `
  --auth-dir "$env:USERPROFILE\.cli-proxy-api" `
  --backup-root "$env:USERPROFILE\.cli-proxy-api-backups\cliproxy-dashboard"
```

`CLI_PROXY_API_BIN` may be used instead of `--cli-proxy-bin`:

```powershell
$env:CLI_PROXY_API_BIN = "C:\Tools\cli-proxy-api\cli-proxy-api.exe"
```

Do not import provider account JSONs or start provider OAuth until the Phase F
provider-auth gate.

### Retained Quota Snapshots

The dashboard persists latest known Proxy Account quota evidence in
`<auth-dir>/cliproxy-dashboard/quota-snapshots.json` by default. A trusted local
run may pass `--state-file <path>`, but the path must resolve inside the same
dashboard-owned state directory and API requests cannot select it.

Proxy Account Keys are derived by stripping a `.disabled` suffix from the local
auth filename and applying a dashboard-local HMAC secret stored outside snapshot
entries. Persisted snapshot entries contain only the opaque key plus allowlisted
`primary5h` and `weekly` evidence. Passed reset times are shown as
`refresh-needed` latest-known evidence until newer identity-bound response
headers arrive. Account-Scoped Quota Refresh remains future discovery.

---

## Deployment as a macOS Launch Agent ⚙️

To ensure the dashboard runs continuously in the background, you can run it as a macOS Launch Agent.

1. Create a launch agent configuration file under `~/Library/LaunchAgents/com.user.cliproxy-dashboard.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.user.cliproxy-dashboard</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/phamtuan/.nvm/versions/node/v24.11.1/bin/node</string>
    <string>dist/cliproxy-dashboard.js</string>
    <string>--port</string>
    <string>60948</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/phamtuan/Workspace/personal/cliproxy-dashboard</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/phamtuan/.local/bin:/Users/phamtuan/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>CLI_PROXY_API_BIN</key>
    <string>/Users/phamtuan/.local/bin/cli-proxy-api</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/phamtuan/.cli-proxy-api/logs/dashboard.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/phamtuan/.cli-proxy-api/logs/dashboard-error.log</string>
</dict>
</plist>
```

2. Bootstrap and start the launch agent:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.cliproxy-dashboard.plist
launchctl kickstart -k gui/$(id -u)/com.user.cliproxy-dashboard
```

3. Restarting the service after updates:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.user.cliproxy-dashboard.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.cliproxy-dashboard.plist
launchctl kickstart -k gui/$(id -u)/com.user.cliproxy-dashboard
```

---

## License 📄

This project is open-source and available under the MIT License.
