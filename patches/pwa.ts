/**
 * BentoPDF PWA file handling integration.
 *
 * Consumes `window.launchQueue` launches triggered by the manifest's
 * `file_handlers` entry (OS "Open with…" for PDFs) and routes each file to
 * the matching tool page. Files cross the page navigation through
 * IndexedDB (File objects are structured-cloneable), and are handed to the
 * tool page by setting the hidden `#file-input` element and dispatching a
 * `change` event, so the page's own upload logic runs exactly as if the
 * user picked the file.
 *
 * Injected into every page by the overlay build.
 */

interface LaunchParams {
  files?: FileSystemFileHandle[];
  targetURL?: string;
}

interface LaunchQueue {
  setConsumer: (consumer: (params: LaunchParams) => void) => void;
}

/**
 * The upstream i18n module's memoized `initI18n` gates all tool-page
 * listener wiring (`onPageReady` awaits it). Awaiting the same promise
 * here means the page's `change` listeners are attached before we hand
 * the launched files over.
 */
import { initI18n } from './i18n/i18n';

declare global {
  interface Window {
    launchQueue?: LaunchQueue;
  }
}

const IDB_NAME = 'bentopdf-pwa';
const IDB_STORE = 'launches';
const LAUNCH_KEY = 'pending-launch';

interface StoredLaunch {
  toolPage: string;
  files: File[];
  savedAt: number;
}

/** Tool page to route each file type to. */
const TOOL_ROUTES: { ext: string[]; page: string }[] = [
  { ext: ['pdf'], page: 'edit-pdf.html' },
  {
    ext: [
      'jpg', 'jpeg', 'png', 'bmp', 'gif', 'tiff', 'tif', 'pnm', 'pgm',
      'pbm', 'ppm', 'pam', 'jxr', 'jpx', 'jp2', 'psd', 'svg', 'heic',
      'heif', 'webp',
    ],
    page: 'image-to-pdf.html',
  },
  { ext: ['doc', 'docx', 'odt', 'rtf'], page: 'word-to-pdf.html' },
  { ext: ['xls', 'xlsx', 'ods'], page: 'excel-to-pdf.html' },
  { ext: ['csv'], page: 'csv-to-pdf.html' },
  { ext: ['ppt', 'pptx', 'odp'], page: 'powerpoint-to-pdf.html' },
  { ext: ['epub'], page: 'epub-to-pdf.html' },
  { ext: ['txt'], page: 'txt-to-pdf.html' },
  { ext: ['md', 'markdown'], page: 'markdown-to-pdf.html' },
];

function routeForFile(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() || '';
  for (const route of TOOL_ROUTES) {
    if (route.ext.includes(ext)) return route.page;
  }
  return null;
}

/** Base path of this deployment (works for project Pages and custom domains). */
function baseUrl(): string {
  return new URL('.', window.location.href).pathname;
}

/* ---------- IndexedDB persistence (File objects survive navigation) ------ */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function storeLaunch(launch: StoredLaunch): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(launch, LAUNCH_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB put aborted'));
    });
    db.close();
  } catch (err) {
    console.warn('[PWA] Could not persist launch:', err);
  }
}

/** Read the stashed launch without deleting it. */
async function peekStoredLaunch(): Promise<StoredLaunch | null> {
  try {
    const db = await openDb();
    const launch = await new Promise<StoredLaunch | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(LAUNCH_KEY);
      req.onsuccess = () => resolve((req.result as StoredLaunch) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IDB get failed'));
    });
    db.close();
    return launch;
  } catch {
    return null;
  }
}

async function takeStoredLaunch(): Promise<StoredLaunch | null> {
  try {
    const db = await openDb();
    const launch = await new Promise<StoredLaunch | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(LAUNCH_KEY);
      req.onsuccess = () => resolve((req.result as StoredLaunch) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IDB get failed'));
    });
    if (launch) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(LAUNCH_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    }
    db.close();
    return launch;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */

/** Common file-input ids across tool pages (fall back to any file input). */
const INPUT_IDS = [
  'file-input',
  'pdfFileInput',
  'pdf-file-input',
  'file-input-1',
];

function findFileInput(): HTMLInputElement | null {
  for (const id of INPUT_IDS) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && el.type === 'file') return el;
  }
  return document.querySelector('input[type="file"]');
}

function applyFilesToPage(files: File[]): boolean {
  const input = findFileInput();
  if (!input) return false;

  try {
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    input.files = dt.files;
  } catch (err) {
    console.warn('[PWA] Could not set file input:', err);
    return false;
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Resolves when the page has wired its `change` listeners. Tool pages bind
 * inside `onPageReady`, which settles at
 * `Promise.all([domReady, Promise.race([initI18n(), 5s])])`. `initI18n` is
 * memoized, so awaiting it here shares the page's own promise; the page's
 * module (loaded before pwa.ts) registered its callback first, and our
 * settling macrotask runs after all its pending microtasks — so the
 * listener is guaranteed attached by the time we dispatch.
 */
async function pageReadyForHandover(): Promise<void> {
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve(), {
        once: true,
      })
    );
  }
  await Promise.race([
    initI18n().then(
      (): void => undefined,
      (): void => undefined
    ),
    new Promise<void>((resolve) => setTimeout(resolve, 5500)),
  ]);
  // Macrotask slack: lets the page's race→all→callback microtask chain
  // finish wiring listeners before we dispatch.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Wait for page wiring, then hand the files over. Retries cover pages that
 * create their file input later than the readiness gate.
 */
async function waitForInputThenApply(
  files: File[],
  timeoutMs = 8000
): Promise<boolean> {
  await pageReadyForHandover();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (applyFilesToPage(files)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/** Route launched files: same page → apply; other page → stash + navigate. */
async function routeLaunch(files: File[]): Promise<void> {
  if (files.length === 0) return;

  let toolPage: string | null = null;
  for (const file of files) {
    const route = routeForFile(file.name);
    if (route) {
      toolPage = route;
      break;
    }
  }

  if (!toolPage) {
    console.warn(
      '[PWA] No tool route for launched files:',
      files.map((f) => f.name)
    );
    return;
  }

  const targetPath = baseUrl() + toolPage;
  const target = new URL(targetPath, window.location.origin);

  // Same page (with or without the .html suffix) → hand files over directly.
  const here = window.location.pathname.replace(/\.html?$/, '');
  const there = target.pathname.replace(/\.html?$/, '');
  if (here === there) {
    await waitForInputThenApply(files);
    return;
  }

  await storeLaunch({ toolPage, files, savedAt: Date.now() });
  window.location.assign(targetPath);
}

async function filesFromHandles(handles: FileSystemFileHandle[]): Promise<File[]> {
  const files: File[] = [];
  for (const handle of handles) {
    try {
      files.push(await handle.getFile());
    } catch (err) {
      console.warn('[PWA] Could not read launched file:', err);
    }
  }
  return files;
}

/**
 * On any page: consume a stashed cross-page launch if it targets this page.
 * The stash is only deleted once the target page actually claims it, so a
 * language-redirect bounce to `/` on the way to the tool page does not
 * lose the launch.
 */
async function consumeStashedLaunch(): Promise<void> {
  const peek = await peekStoredLaunch();
  if (!peek) return;

  const target = new URL(baseUrl() + peek.toolPage, window.location.origin);
  if (target.pathname !== window.location.pathname) {
    // Still in transit (e.g. language redirect on `/`); the stash survives
    // until the target page loads and claims it.
    return;
  }

  const fresh = Date.now() - peek.savedAt < 60_000;
  if (!fresh) {
    await takeStoredLaunch(); // expired — clear it
    return;
  }

  await waitForInputThenApply(peek.files);
  await takeStoredLaunch(); // claimed — clear it
}

function initPwaFileHandling(): void {
  const queue = window.launchQueue;
  if (queue && typeof queue.setConsumer === 'function') {
    void queue.setConsumer(async (params) => {
      if (!params.files || params.files.length === 0) return;
      const files = await filesFromHandles(params.files);
      await routeLaunch(files);
    });
  }
  void consumeStashedLaunch();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPwaFileHandling);
} else {
  initPwaFileHandling();
}

export {};
