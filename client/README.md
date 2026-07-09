# client

The `widgetsack` frontend: a React 19 + TypeScript SPA built with Vite, loaded by the Tauri
webview. See the repo root [AGENTS.md](../AGENTS.md) for the full architecture.

## Developing

Install dependencies, then start the dev server (browser-only; no Tauri APIs):

```bash
npm i
npm run dev
```

For the full desktop app (Tauri starts this dev server for you), run `cargo tauri dev` from
the repo root instead.

## Building

```bash
npm run build
```

Output goes to `client/build`, which Tauri embeds as `frontendDist`. Build the frontend
before any `cargo build` / `cargo test` / `cargo clippy`.

## Checks

```bash
npm run check       # tsc --noEmit type checking
npm run lint        # oxfmt + oxlint (zero warnings)
npm run test:unit   # Vitest unit/component tests
```
