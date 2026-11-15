#!/usr/bin/env node
/**
 * Overlay patch script: applies bentopdf-web PWA enhancements on top of a
 * fresh clone of upstream bentopdf before building for GitHub Pages.
 *
 * Usage:  node apply.mjs /path/to/bentopdf-clone
 *
 * Patches applied:
 *  1. site.webmanifest   — file_handlers, id/scope/start_url, launch_handler,
 *                          orientation:any (from patches/site.webmanifest)
 *  2. src/js/pwa.ts      — launchQueue file-handling router (new file)
 *  3. pwa.ts script tag  — injected into every HTML page (index, tool pages,
 *                          root pages)
 *  4. viewport meta      — add viewport-fit=cover for safe areas
 *  5. theme-color meta   — match the manifest theme_color
 *  6. sw.js              — precache the app shell (offline start)
 *  7. mobile css         — safe-area padding, tap-target sizing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.resolve(__dirname, '.');

const target = process.argv[2];
if (!target) {
  console.error('usage: node apply.mjs <bentopdf-clone-dir>');
  process.exit(1);
}
const root = path.resolve(target);
if (!fs.existsSync(path.join(root, 'package.json'))) {
  console.error(`not a bentopdf checkout: ${root}`);
  process.exit(1);
}

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);

function patchHtml(html) {
  let out = html;

  // 1. viewport-fit=cover for notches/safe areas
  out = out.replace(
    /<meta\s+name="viewport"\s+content="([^"]*)"\s*\/>/,
    (m, content) =>
      content.includes('viewport-fit')
        ? m
        : `<meta name="viewport" content="${content}, viewport-fit=cover" />`
  );

  // 2. theme-color (after viewport meta)
  if (!out.includes('name="theme-color"')) {
    out = out.replace(
      /(<meta\s+name="viewport"[^>]*\/>)/,
      `$1\n    <meta name="theme-color" content="#4f46e5" />`
    );
  }

  // 3. Inject pwa.ts (launchQueue file handling) on every page that has a
  //    manifest link — after the last existing module script in <body>.
  if (!out.includes('pwa.ts')) {
    const lastScript = out.lastIndexOf('<script type="module"');
    if (lastScript !== -1) {
      const close = out.indexOf('</script>', lastScript);
      if (close !== -1) {
        const insertAt = close + '</script>'.length;
        out =
          out.slice(0, insertAt) +
          `\n    <script type="module" src="${scriptSrc(out)}"></script>` +
          out.slice(insertAt);
      }
    }
  }

  return out;
}

/** Compute the script src path relative to each HTML file's location. */
function scriptSrc(html) {
  // Vite rewrites `/src/...` correctly for BASE_URL builds via its own
  // asset pipeline; tool pages already use /src/js/... absolute dev paths
  // that the rewriteHtmlPathsPlugin handles. Match that convention.
  return '/src/js/pwa.ts';
}

/* ------------------------------------------------------------------------ */

function applyManifest() {
  const src = path.join(PATCHES, 'site.webmanifest');
  const dst = path.join(root, 'public', 'site.webmanifest');
  write(dst, read(src));
  console.log('[patch] public/site.webmanifest — file_handlers + PWA fields');
}

function applyPwaModule() {
  const src = path.join(PATCHES, 'pwa.ts');
  const dst = path.join(root, 'src', 'js', 'pwa.ts');
  write(dst, read(src));
  console.log('[patch] src/js/pwa.ts — launchQueue file handling router');
}

function applyHtmlPatches() {
  const pages = [
    ...fs
      .readdirSync(path.join(root, 'src', 'pages'))
      .filter((f) => f.endsWith('.html'))
      .map((f) => path.join(root, 'src', 'pages', f)),
    ...fs
      .readdirSync(root)
      .filter(
        (f) =>
          f.endsWith('.html') &&
          !['404.html'].includes(f) &&
          !fs.lstatSync(path.join(root, f)).isSymbolicLink?.()
      )
      .map((f) => path.join(root, f)),
  ];

  let patched = 0;
  for (const page of pages) {
    let stat;
    try {
      stat = fs.lstatSync(page);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const html = read(page);
    const next = patchHtml(html);
    if (next !== html) {
      write(page, next);
      patched++;
    }
  }
  console.log(
    `[patch] HTML pages (viewport-fit, theme-color, pwa.ts script): ${patched} patched`
  );
}

function applySwPatch() {
  const swPath = path.join(root, 'public', 'sw.js');
  let sw = read(swPath);

  // 1. Precache the app shell so the PWA starts offline. Entries must be
  //    bare names: buildCriticalAssets joins them as `${basePath}/${asset}`.
  //    The vite sw-precache plugin fills PRECACHE_ASSETS with hashed worker
  //    assets at build time (its regex is preserved).
  if (!sw.includes('bentopdf-pwa-shell')) {
    const shell = [
      'index.html',
      'site.webmanifest',
      'images/favicon.svg',
      'images/favicon-192x192.png',
      'images/favicon-512x512.png',
      'images/apple-touch-icon.png',
    ];
    const shellList = shell.map((s) => `  '${s}',`).join('\n');

    sw = sw.replace(
      /const PRECACHE_ASSETS = \[([\s\S]*?)\];/,
      `const PRECACHE_ASSETS = [$1];\n\n// bentopdf-pwa-shell (overlay): precached app shell for offline start\nconst SHELL_ASSETS = [\n${shellList}\n];`
    );
    sw = sw.replace(
      /return PRECACHE_ASSETS\.map\(/,
      'return [...PRECACHE_ASSETS, ...SHELL_ASSETS].map('
    );
  }

  // 2. The fetch handler's HTML branch matches `url.pathname === '/'` and
  //    `/^\/(en|…)(\/|$)/` — both break under a project Pages base path
  //    (/bentopdf/), so the homepage/index would never be served offline.
  //    Make the language regex base-path aware via a computed matcher.
  if (!sw.includes('bentopdf-pwa-basepath')) {
    // Add a helper that strips the base path from a pathname.
    sw = sw.replace(
      /const PRECACHE_ASSETS = \[/,
      `// bentopdf-pwa-basepath (overlay): strip scope base from request paths
const stripBasePath = (pathname) => {
  const base = getBasePath();
  if (base && pathname.startsWith(base + '/')) {
    return pathname.slice(base.length) || '/';
  }
  return pathname;
};

const PRECACHE_ASSETS = [`
    );

    // Rewrite the HTML-branch pathname checks to use the stripped path.
    sw = sw.replace(
      /(url\.pathname\.endsWith\('\.html'\)\s*\|\|\s*\n?\s*)url\.pathname === '\/'/,
      `$1stripBasePath(url.pathname) === '/'`
    );

    // Rewrite the language-prefix regex test to run on the stripped path.
    // The literal contains escaped slashes (`\/`), which makes a regex-based
    // replace error-prone — locate it by its unique `zh-TW` content instead.
    const langTest = sw.indexOf('zh-TW');
    if (langTest === -1) {
      throw new Error('[patch] sw.js: language regex (zh-TW) not found');
    }
    const testCallStart = sw.indexOf('.test(', langTest);
    const argStart = testCallStart + '.test('.length;
    const argEnd = sw.indexOf(')', argStart);
    const langArg = sw.slice(argStart, argEnd);
    if (langArg.trim() === 'url.pathname') {
      sw =
        sw.slice(0, argStart) +
        'stripBasePath(url.pathname)' +
        sw.slice(argEnd);
    }
  }

  write(swPath, sw);
  console.log('[patch] public/sw.js — app-shell precache + base-path HTML matching');
}

function applyMobileCss() {
  const cssPath = path.join(root, 'src', 'css', 'styles.css');
  let css = read(cssPath);

  if (!css.includes('bentopdf-pwa-mobile')) {
    css += `
/* --- bentopdf-pwa-mobile (overlay) ------------------------------------- */

/* Safe-area insets for notched phones in standalone mode */
:root {
  --pwa-safe-top: env(safe-area-inset-top, 0px);
  --pwa-safe-bottom: env(safe-area-inset-bottom, 0px);
  --pwa-safe-left: env(safe-area-inset-left, 0px);
  --pwa-safe-right: env(safe-area-inset-right, 0px);
}

@media (display-mode: standalone), (display-mode: fullscreen) {
  /* Keep tap targets comfortable on touch devices */
  body {
    padding-left: var(--pwa-safe-left);
    padding-right: var(--pwa-safe-right);
  }

  header nav,
  .navbar,
  #mobile-menu {
    padding-top: var(--pwa-safe-top);
  }

  footer {
    padding-bottom: var(--pwa-safe-bottom);
  }

  /* Comfortable tap targets for primary buttons */
  .btn,
  button:not(.icon-btn):not(.tool-fav-btn) {
    min-height: 44px;
  }

  /* No text selection fights with scrolling on touch */
  body {
    -webkit-tap-highlight-color: transparent;
  }
}

/* Prevent horizontal overflow on narrow screens */
html,
body {
  max-width: 100vw;
  overflow-x: hidden;
}
`;
    write(cssPath, css);
    console.log('[patch] src/css/styles.css — safe-area + standalone mobile polish');
  }
}

/* ------------------------------------------------------------------------ */

applyManifest();
applyPwaModule();
applyHtmlPatches();
applySwPatch();
applyMobileCss();

console.log('[patch] overlay applied successfully');
