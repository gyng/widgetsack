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

1. Bump the version in [widgetsack/tauri.conf.json](../widgetsack/tauri.conf.json) and
   [widgetsack/Cargo.toml](../widgetsack/Cargo.toml)
2. Add the release's section to [CHANGELOG.md](../CHANGELOG.md)
3. Create a new release on the [releases](https://github.com/gyng/widgetsack/releases) page.
