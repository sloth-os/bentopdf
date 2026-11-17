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
 *  8. editor mobile css  — edit-pdf viewer fills the phone screen when open
 *  9. editor init guard  — resetViewer() on init failure so the mobile
 *                          full-screen gate disengages and retry is possible
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

function applyEditorMobileCss() {
  const cssPath = path.join(root, 'src', 'css', 'styles.css');
  let css = read(cssPath);

  if (!css.includes('bentopdf-pwa-editpdf')) {
    // Drift guard: this stage blind-appends CSS keyed on upstream ids and
    // structure, so assert them here and fail the build on drift — same
    // convention as applyEditorInitGuard / applySwPatch. deploy-pages.yml
    // re-clones upstream fresh every week; without this, a rename would
    // ship a silently inert (or half-applied) gate.
    const htmlPath = path.join(root, 'src', 'pages', 'edit-pdf.html');
    const pageHtml = read(htmlPath);
    const anchors = [
      [htmlPath, [
        'id="uploader"',
        'id="tool-uploader"',
        'id="back-to-tools"',
        'id="drop-zone"',
        'id="file-display-area"',
        'id="embed-pdf-wrapper"',
        'id="embed-pdf-container"',
        '{{> navbar }}',
        '{{> footer }}',
      ]],
      // body > nav / body > footer come from the partials
      [path.join(root, 'src', 'partials', 'navbar.html'), ['<nav']],
      [path.join(root, 'src', 'partials', 'footer.html'), ['<footer']],
      // #download-edited-pdf is created at runtime, not in the HTML
      [path.join(root, 'src', 'js', 'logic', 'edit-pdf-page.ts'), [
        "'download-edited-pdf'",
      ]],
      // Tailwind utilities must stay layered so this unlayered append wins
      [cssPath, ["@import 'tailwindcss'"]],
    ];
    for (const [file, needles] of anchors) {
      const src = read(file);
      for (const needle of needles) {
        if (!src.includes(needle)) {
          throw new Error(
            `[patch] editor mobile css: ${needle} missing from ` +
              `${path.relative(root, file)} — upstream drifted; update the CSS gate`
          );
        }
      }
    }
    // containment: the wrapper must stay nested inside #uploader (the gate
    // argument chain and every #uploader:has(...) selector assume it)
    if (
      pageHtml.indexOf('id="uploader"') >
      pageHtml.indexOf('id="embed-pdf-wrapper"')
    ) {
      throw new Error(
        '[patch] editor mobile css: #embed-pdf-wrapper no longer nested in #uploader'
      );
    }

    css += `
/* --- bentopdf-pwa-editpdf (overlay) ------------------------------------- */
/* Phones: while a document is open in the PDF editor, turn the page into a
   full-screen editing surface. The gate has two parts because .hidden alone
   is NOT an exact "editor active" hook: handleFiles removes .hidden from
   #embed-pdf-wrapper BEFORE awaiting import('bentopdf-viewer') (~1.4MB lazy
   chunk, never precached), so a chunk/init failure would otherwise strand a
   phone on a blank full-screen surface with the drop zone hidden and no way
   to retry. EmbedPDF.init() synchronously appends <embedpdf-container> into
   #embed-pdf-container, so requiring :not(:empty) means "the viewer actually
   mounted": the stock layout (drop zone included) stays on screen during
   chunk download and after any failure that happens before the mount. The
   container check is written in descendant form (wrapper ... container) not
   as a nested :has() on the wrapper, because nested :has(:has()) is not
   valid selector syntax in Chromium and would drop every rule. Post-mount
   failures that actually THROW (sync errors once viewerInstance.registry
   has resolved, e.g. a missing plugin) reach handleFiles()'s catch, where
   the overlay's edit-pdf-page.ts init guard calls resetViewer(), emptying
   the container and re-adding .hidden. A wasm/engine load failure is
   covered by NEITHER layer — upstream behavior documented but not changed
   here: in the pinned viewer bundle the container's registry promise keeps
   only its resolver (it can never reject) and the engine hook swallows load
   errors into a permanent "Initializing PDF engine..." spinner, so the
   await on viewerInstance.registry hangs and neither the catch/guard nor
   the finally's hideLoader() ever runs — the z-50 loader stays up with no
   dismissal. Covering that would need a timeout race around the await.
   (Note: closing the viewer's tabs does NOT restore the stock page —
   upstream's onDocumentClosed reads data?.id off the raw id string the
   viewer emits, so removeFileEntry/resetViewer never fire; the viewer just
   falls back to its own empty state, which has an Open File button, and
   #back-to-tools remains the exit. Not fixed here: repairing that handler
   would re-enable resetViewer-on-last-close, whose interaction with
   untracked "+"-opened documents is upstream's call, not the overlay's.)
   Only edit-pdf.html contains #embed-pdf-wrapper, so no other page matches,
   and engines without :has()
   drop the whole block and keep the stock layout. The gate also covers
   landscape phones (short touch viewports) where the stock 75vh box is even
   more cramped relative to the screen. */

@media (max-width: 767px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {
  /* Site chrome yields the screen to the document. The sticky navbar is
     65px, and the How-It-Works / Related-Tools / FAQ sections plus footer
     made the page ~3500px tall so it kept scrolling behind the editor.
     Escape hatches stay: #back-to-tools below, and the viewer's own Open
     File button in its tab bar (closing all tabs leaves the viewer's empty
     state, still full-screen, ready to open another file). The
     z-50 loader/alert modals and the runtime confirm overlay are divs,
     so they keep working. Side body padding is zeroed here because the
     card rule below consumes the side insets directly (see next block).
     The gate argument starts at #uploader so every rule in this block keys
     on the same chain (uploader > wrapper > container): if any link is
     ever renamed upstream the whole block goes inert as a clean no-op
     (stock layout) instead of the body rules half-applying — hiding the
     navbar/sections/footer around a stock 75vh box with body scroll
     disabled. The drift guard in apply.mjs additionally turns such a
     rename into a build failure. */
  body:has(#uploader #embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) {
    overflow: hidden;
    padding-left: 0;
    padding-right: 0;
  }
  body:has(#uploader #embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) > nav,
  body:has(#uploader #embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) > section,
  body:has(#uploader #embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) > footer {
    display: none;
  }

  /* The column is exactly the dynamic viewport, no scroll. */
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) {
    height: 100vh;
    height: 100dvh;
    min-height: 0;
    padding: 0;
    overflow: hidden;
  }

  /* Card becomes a full-bleed flex column so the viewer can flex-grow.
     All four safe-area insets are consumed here (the navbar that used to
     cover the top inset is hidden, and the body rule above zeroes the
     standalone side padding so landscape-notch insets in browser tabs
     apply exactly once instead of not at all or twice). */
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #tool-uploader {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: 100%;
    max-width: none;
    margin: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding: 0.25rem;
    padding-top: calc(0.25rem + env(safe-area-inset-top, 0px));
    padding-bottom: calc(0.25rem + env(safe-area-inset-bottom, 0px));
    padding-left: calc(0.25rem + env(safe-area-inset-left, 0px));
    padding-right: calc(0.25rem + env(safe-area-inset-right, 0px));
  }

  /* Marketing copy and the redundant upload UI are not needed while
     editing: the viewer's tab bar lists open documents with close buttons
     and has its own Open File button. #drop-zone is hidden but #file-input
     stays in the DOM, so the PWA launch handler can still assign .files and
     dispatch \`change\` to hand an OS-opened file to the running editor. */
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #tool-uploader > h1,
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #tool-uploader > p,
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #drop-zone,
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #file-display-area {
    display: none;
  }

  /* Compact exit affordance (2rem keeps it a comfortable tap target). */
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #back-to-tools {
    flex: 0 0 auto;
    align-self: flex-start;
    min-height: 2rem;
    margin: 0 0 0.25rem;
    padding: 0 0.25rem;
    font-size: 0.8125rem;
    line-height: 1.25rem;
  }

  /* Viewer takes every remaining pixel. flex-basis:0% overrides the
     h-[75vh] utility without a specificity fight. The viewer root
     (<embedpdf-container>, the sole child EmbedPDF.init appends into this
     box) already stretches to 100%/100% of it — but via the VENDORED
     viewer bundle's own shadow-root :host rule (display:flex;
     flex-direction:column; overflow:hidden; width:100%; height:100%), NOT
     via styles.css's '#embed-pdf-container > div', which never matches
     (the root is a custom element, not a div). So it is a viewer bundle
     upgrade, not a CSS edit, that can silently break this sizing. EmbedPDF
     re-fits on container resize (ResizeObserver in its dist bundle). No
     overflow rule here: the viewer's absolutely-positioned menus must not
     be clipped. */
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #embed-pdf-wrapper {
    flex: 1 1 0%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    margin: 0;
  }
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #embed-pdf-container {
    flex: 1 1 0%;
    min-height: 0;
    height: auto;
    border: 0;
    border-radius: 0;
  }

  /* Keep the save button — the viewer's document-menu Export runs the same
     downloadEditedPdf pipeline (upstream re-points 'document:export' at
     it), but the button is the obvious mobile affordance and a fallback if
     the menu icon is missed — and stop the mt-6 + default padding from
     eating 72px. 2.5rem stays a safe tap target. */
  #uploader:has(#embed-pdf-wrapper:not(.hidden) #embed-pdf-container:not(:empty)) #download-edited-pdf {
    flex: 0 0 auto;
    margin-top: 0.25rem;
    min-height: 2.5rem;
    padding-top: 0.375rem;
    padding-bottom: 0.375rem;
    font-size: 0.875rem;
    border-radius: 0.5rem;
  }
}
`;
    write(cssPath, css);
    console.log(
      '[patch] src/css/styles.css — edit-pdf full-screen mobile editor'
    );
  }
}

function applyEditorInitGuard() {
  const tsPath = path.join(root, 'src', 'js', 'logic', 'edit-pdf-page.ts');
  let ts = read(tsPath);

  if (!ts.includes('bentopdf-pwa-editpdf-initguard')) {
    // handleFiles() removes .hidden from #embed-pdf-wrapper, THEN awaits
    // import('bentopdf-viewer') / EmbedPDF.init() / viewerInstance.registry.
    // Upstream's catch only alerts: if init fails after the wrapper was
    // un-hidden, the mobile full-screen CSS gate (which keys on the wrapper
    // being un-hidden AND the container being non-empty) would strand a
    // phone on a blank editing surface with the drop zone hidden. Restore
    // the stock page instead so the gate disengages and retry is possible.
    // Guarded by isViewerInitialized: the same catch also covers adding
    // files to an ALREADY LIVE editor (else branch), where resetViewer()
    // would destroy open documents — never call it in that state.
    // Only failures that THROW reach this catch: a wasm/engine load
    // failure leaves the registry promise pending forever (see the
    // applyEditorMobileCss note), so this guard cannot cover it.
    const needle = `console.error('Error loading PDF Editor:', error);`;
    if (ts.split(needle).length !== 2) {
      throw new Error(
        '[patch] edit-pdf-page.ts: init catch marker not found exactly once'
      );
    }
    ts = ts.replace(
      needle,
      `${needle}
    // bentopdf-pwa-editpdf-initguard (overlay): a failed first init must not
    // leave the mobile full-screen editor gate engaged on a dead viewer.
    // !docManagerPlugin too: it is assigned only after the viewer registry
    // resolves, so it is still null for every failure this guard exists for
    // (chunk import, EmbedPDF.init, registry/wasm, getPlugin) and non-null
    // exactly when a live document manager exists — e.g. a later file's
    // arrayBuffer() rejecting mid-loop after document 0 already opened,
    // where isViewerInitialized is still false but resetViewer() would
    // destroy the open document (upstream leaves it live).
    if (!isViewerInitialized && !docManagerPlugin) resetViewer();`
    );
    write(tsPath, ts);
    console.log(
      '[patch] src/js/logic/edit-pdf-page.ts — resetViewer() on init failure'
    );
  }
}

/* ------------------------------------------------------------------------ */

applyManifest();
applyPwaModule();
applyHtmlPatches();
applySwPatch();
applyMobileCss();
applyEditorMobileCss();
applyEditorInitGuard();

console.log('[patch] overlay applied successfully');
