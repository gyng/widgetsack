# Development

Build the full application on Windows.
The React client and its tests can also run on other operating systems.
Read [AGENTS.md](../../AGENTS.md) before making changes.

## Setup

Install the Windows prerequisites for Tauri and Rust 1.90 or later.
Use Node 24 with npm, as CI does.
Use a Tauri v2 CLI.
Install client dependencies from `client/`:

```powershell
npm ci
```

Run the application from the repository root:

```powershell
cargo tauri dev
```

Tauri starts the Vite server on port 1420.
For a browser-only client, run `npm run dev` from `client/`.
Run `cargo run -- --multi` for an isolated second instance.
Its configuration lives in the `multi` subdirectory.

## Required checks

Run these commands from `client/`:

```powershell
npm run check
npm run lint
npm run test:coverage
npm run build
```

Lint uses oxfmt and oxlint and must pass without warnings.
The included unit-test scope requires 100% coverage.
Run `npm run test:e2e` when changing Studio layout or interaction.
Install Playwright Chromium first if it is missing.

After building the client, run these commands from the repository root:

```powershell
cargo fmt --check
cargo test
cargo clippy
```

Tauri embeds `client/build`, so build the frontend before Rust checks.
Use `cargo tauri build` to create an installer.
See [CI checks](../../.github/workflows/test.yml) for the current gate configuration.

## Documentation and screenshots

Run these commands from `client/`:

| Command               | Result                                            |
| --------------------- | ------------------------------------------------- |
| `npm run gen:docs`    | Regenerate widget, template, and theme references |
| `npm run check:docs`  | Check reference freshness                         |
| `npm run gen:shots`   | Update widget screenshots                         |
| `npm run gen:gallery` | Update widget screenshots and references          |
| `npm run gen:presets` | Update preset screenshots                         |

Edit generators or registry metadata before regenerating references.
See [Documentation](documentation.md) for writing and review rules.

## Agent maintenance

CLI discovery and decoding live in `studio_agent_cli.rs`.
Process ownership, bounded output, timeouts, and cancellation live in `studio_agent.rs`.
The assistant prefers installed Pi, Codex, and Claude in that order.
Standard npm shims resolve to an installed JavaScript entry point and Node executable.
Standalone executables do not require Node.

Agents keep their existing login and model settings.
AI Provider widget credentials are separate.
Run `cargo test studio_agent` for native protocol and lifecycle checks.

The installer removes legacy bundled agent resources during upgrades.
After an NSIS build, run `widgetsack/windows/test-agent-cleanup.ps1` against its isolated fixtures.
The release workflow runs this check before upload.

## Release

The [release workflow](../../.github/workflows/build.yml) starts when a `v*` tag is pushed.
Use a draft release to keep the release private until its installer is available.

Start each version's changelog entry with a short, plain-language summary of the main changes and
their benefit to users. Put it before the Added, Changed and Fixed lists, and include it at the top
of the GitHub release notes too.

1. Set the same version in `widgetsack/tauri.conf.json`, `widgetsack/Cargo.toml`, and `client/package.json`.
2. Refresh lockfiles through their package managers if required.
3. Add the version section to [CHANGELOG.md](../../CHANGELOG.md).
4. Run the required checks and merge the changes to `main`.
5. Create a draft release for `v<version>` with the release notes.
6. Tag the checked commit and push that tag.
7. Wait for the release workflow to finish.
8. Check the installer asset, cleanup test, and attestation results.
9. Publish the draft.

The in-app update check sees published releases only.
Do not publish before the installer is attached.
