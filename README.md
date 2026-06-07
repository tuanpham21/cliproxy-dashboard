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

* **Core**: Pure HTML & Client-side Vanilla JS (TypeScript compiled)
* **Server**: Node.js HTTP Server (`src/cliproxy-dashboard.ts`)
* **Styling**: Vanilla CSS (no Tailwind required, utilizing native variables, glassmorphic blurs, and keyframe animations)
* **Build System**: TypeScript (`tsc`)
* **Test Runner**: Vitest (`src/cliproxy-dashboard.test.ts`)

---

## Directory Structure 📂

```
cliproxy-dashboard/
├── dist/                # Compiled JavaScript output
├── src/                 # TypeScript Source code
│   ├── cliproxy-dashboard.ts       # Main server & HTML page generator
│   └── cliproxy-dashboard.test.ts  # Vitest unit test suite
├── tsconfig.json        # TypeScript configuration compiler options
├── package.json         # Scripts, dependencies, and devDependencies
└── .gitignore           # File/folder exclusion list
```

---

## Getting Started 🚀

### Prerequisites
* **Node.js**: `v20` or higher
* **Go CLI Proxy**: The `/Users/phamtuan/.local/bin/cli-proxy-api` binary should be installed and accessible.

### Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/tuanpham21/cliproxy-dashboard.git
cd cliproxy-dashboard
npm install
```

### Scripts

* **Start in Development Mode**:
  ```bash
  npm run dev
  ```
* **Build the Codebase**:
  ```bash
  npm run build
  ```
* **Run the Test Suite**:
  ```bash
  npm run test
  ```
* **Start Server**:
  ```bash
  npm run start
  ```

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
  <string>/Users/phamtuan/Workspace/personal/services-portal/cliproxy-dashboard</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/phamtuan/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/phamtuan/.cli-proxy-api/logs/dashboard.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/phamtuan/.cli-proxy-api/logs/dashboard-error.log</string>
</dict>
</plist>
```

2. Load and start the launch agent:
```bash
launchctl load ~/Library/LaunchAgents/com.user.cliproxy-dashboard.plist
```

3. Restarting the service after updates:
```bash
launchctl unload ~/Library/LaunchAgents/com.user.cliproxy-dashboard.plist && launchctl load ~/Library/LaunchAgents/com.user.cliproxy-dashboard.plist
```

---

## License 📄

This project is open-source and available under the MIT License.
