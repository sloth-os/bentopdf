# bentopdf-web

PWA overlay for [BentoPDF](https://github.com/alam00000/bentopdf), published to
GitHub Pages. This repo does **not** vendor upstream code: a GitHub Actions
workflow clones upstream fresh, applies the patches in `patches/`, builds, and
deploys `dist/` — weekly (Mondays 06:07 UTC), on every push to `main`, and
manually via *Run workflow*.

## What the overlay adds

`node patches/apply.mjs <upstream-clone-dir>` (idempotent) applies:

| Component | Effect |
| --- | --- |
| `patches/site.webmanifest` | `file_handlers` (OS *"Open with…"* → BentoPDF for `.pdf`), `launch_handler: focus-existing`, relative `start_url`/`scope`/`id` so the manifest works under any base path |
| `patches/pwa.ts` | `window.launchQueue` router: maps each launched file to its tool page (`edit-pdf`, `image-to-pdf`, `word-to-pdf`, …), carries `File` objects across navigation through IndexedDB, and awaits upstream's memoized `initI18n` (the `onPageReady` gate) before dispatching `change`, so the page's listeners are wired |
| `public/sw.js` patches | precaches the app shell (`SHELL_ASSETS`) for an offline start; adds `stripBasePath()` so the HTML/language-route matching works under a Pages project path (`/bentopdf/…`) |
| HTML patches (all pages) | `viewport-fit=cover`, `theme-color`, injects the `pwa.ts` module |
| `src/css/styles.css` | safe-area insets for notched phones, ≥44px tap targets, standalone-mode polish, no horizontal overflow |

## CI environment

The workflow (`.github/workflows/deploy-pages.yml`) sets:

- `BASE_URL=/<repo-name>` — vite builds with base `/<repo-name>/`
- `SITE_URL=https://<owner>.github.io/<repo-name>` — sitemap/canonicals point at
  this deployment; pages are marked `noindex` (it's a mirror of the official
  site — set `ALLOW_INDEXING=true` in the workflow env to change that)
- optional repo variable `UPSTREAM_REPO` to track a different upstream

GitHub Pages must be enabled with source **GitHub Actions**
(`actions/configure-pages` in the workflow handles this).

## Local testing

```bash
git clone --depth 1 https://github.com/alam00000/bentopdf.git /tmp/bentopdf
node patches/apply.mjs /tmp/bentopdf
cd /tmp/bentopdf && npm ci && BASE_URL=/bentopdf npm run build
```

The build takes ~10 minutes (the i18n step generates ~3200 pages).
