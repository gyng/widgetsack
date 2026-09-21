# Development

The architecture and roadmap live in [widget-platform.md](widget-platform.md).

## Getting started

> **Note**  
> widgetsack has to be built on Windows.

Install [Tauri prerequisites](https://tauri.app/start/prerequisites/) first, plus a current
**v2** Tauri CLI (the project uses tauri 2.11):

```sh
# if `cargo tauri` is missing or older than 2.x:
$ cargo install tauri-cli --version "^2" --locked
```

```sh
# Install client dependencies first
$ (cd client && npm i)

# Run the full app in dev (Tauri starts the Vite dev server for you)
$ cargo tauri dev

# Build the frontend before the Rust checks — Tauri embeds client/build,
# so cargo test/clippy fail if it is missing
$ (cd client && npm run build)
$ cargo test
$ cargo clippy

# If needed; output is target/release/widgetsack.exe
$ cargo tauri build

# Client tests and checks (run from client/)
$ (cd client && npm run test:unit)   # Vitest unit/component tests
$ (cd client && npm run check)       # tsc --noEmit type checking
$ (cd client && npm run lint)        # Prettier + ESLint
```

## Release

The installer is attached to the release **before** it goes public: the build workflow
([build.yml](../.github/workflows/build.yml)) triggers on `release: created`, which fires for
**draft** releases, so create the release as a draft, wait for the build, then publish. The app's
own background update check (`update.rs`, GitHub "latest release") only sees published releases,
so nobody is pointed at an asset-less release.

1. Bump the version in [widgetsack/tauri.conf.json](../widgetsack/tauri.conf.json),
   [widgetsack/Cargo.toml](../widgetsack/Cargo.toml) and [client/package.json](../client/package.json)
   (they must agree — CI's `version_check` job in [test.yml](../.github/workflows/test.yml) fails
   if `tauri.conf.json` and `Cargo.toml` differ, or if the CHANGELOG has no section for that version).
2. Add the release's `## <version>` section to [CHANGELOG.md](../CHANGELOG.md) and land it on `main`.
3. Create the release as a **draft** on the tag `v<version>` (the tag must match the version files —
   build.yml asserts this before building):

   ```sh
   $ gh release create v0.0.56 --draft --title "0.0.56" --notes-file <(sed -n '/^## 0.0.56/,/^## /p' CHANGELOG.md | sed '$d')
   ```

   (or just `--notes-file release-notes.md` with the section pasted out of the CHANGELOG).
4. Wait for the "Build release" workflow the draft triggered to finish — it builds, uploads the
   installer with retries, and attests provenance:

   ```sh
   $ gh run watch --workflow "Build release"
   $ gh release view v0.0.56   # the *-setup.exe asset should be listed
   ```

5. Publish the draft:

   ```sh
   $ gh release edit v0.0.56 --draft=false
   ```

   Only now does `releases/latest` (and the in-app update check / tray item) point at it.

> A release created directly as public (not a draft) still builds — `created` fires for it too —
> but it is visible for the ~10 minutes the build takes before its asset appears.
