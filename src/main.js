// ============================================
// IMPORTS
// ============================================
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  Menu,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// ============================================
// DEVELOPMENT PROFILE ISOLATION
// ============================================
// A development run (`npm start`, i.e. `electron .`) and an INSTALLED Folia
// share an application name, so Electron hands them the same userData
// directory - and that directory is not merely storage. MEASURED with two
// concurrent Electron processes: requestSingleInstanceLock() is keyed on
// userData (same profile -> the second process is refused and forwards its
// argv to the first; different profiles -> both are granted). So without this,
// launching the dev build while the installed build is running does not start
// a second app at all: it hands the file to the installed one and exits. The
// two also share the tab session, window bounds, recent files and debug.log,
// so each overwrites the other's state.
//
// Guarded on !app.isPackaged, so a shipped build is untouched and keeps the
// exact profile it has always used.
//
// ORDERING IS LOAD-BEARING. app.setPath("userData", ...) is silently ignored
// once the app is ready, and two things below CAPTURE the profile path into
// module-scope constants - WINDOW_STATE_FILE and logFilePath. This must stay
// above both of them;
// (A third module-scope read, the log("User data path:", ...) line, only
// REPORTS the path rather than capturing it, so it is not part of this
// invariant. The claim is deliberately about capture, not about reads: "reads"
// is falsifiable by one grep and would rot the moment another report is added.)
// test/test-packaging.js asserts that statically because "it did not move" is
// an absence check and absence checks fail open.
const DEV_PROFILE_SUFFIX = "-dev";

// Pure, and separated from the application of it on purpose: a decision that is
// only observable by booting Electron and looking at where files landed can
// only be tested end to end, whereas this can be driven directly against a stub
// (test/test-dev-profile.js does exactly that).
function devProfileDecision(app) {
  if (app.isPackaged) return { target: null, reason: "packaged" };

  const appData = app.getPath("appData");
  const name = app.getName();
  const standard = path.join(appData, name);

  // Something has ALREADY relocated the profile - test/test-userdata-isolation.js
  // gives every suite its own directory, and Chromium's --user-data-dir switch
  // does the same from the command line. Overriding that here would silently
  // undo it, which in the harness's case means eight suites sharing one profile
  // again: precisely the contamination that module exists to prevent, and it
  // would not fail - it would just quietly stop being isolated.
  if (path.resolve(app.getPath("userData")) !== path.resolve(standard)) {
    return { target: null, reason: "already-relocated" };
  }

  return {
    target: path.join(appData, name + DEV_PROFILE_SUFFIX),
    reason: "dev",
  };
}

function applyDevProfile() {
  const decision = devProfileDecision(app);
  if (!decision.target) return decision;

  app.setPath("userData", decision.target);

  // setPath fails OPEN, so read it back rather than trusting the call. A warning
  // rather than a throw: an exception raised while the main process is loading
  // becomes dialog.showErrorBox - a modal owned by the process that is failing -
  // and this is a developer-convenience path, not a correctness one.
  if (path.resolve(app.getPath("userData")) !== path.resolve(decision.target)) {
    console.warn(
      "dev profile not applied - userData is still " +
        app.getPath("userData") +
        "; a development run will share the installed app's profile.",
    );
    return { target: null, reason: "setpath-ignored" };
  }
  return decision;
}
// MEASURED END TO END, because no suite can do it: every windowed suite
// relocates userData before requiring this file, so the redirect correctly
// DECLINES there and its positive half is unobservable from inside the harness.
// Hand-run once, on the real product invocation (`electron .`), 2026-08-28:
// <appData>\Folia-dev was created and received window-state.json and debug.log,
// while <appData>\Folia's mtime did not move at all. So a development run
// genuinely lands in the sibling and genuinely leaves an installed Folia's
// profile untouched.
applyDevProfile();

// ============================================
// DEVTOOLS EXPOSURE
// ============================================

// The renderer runs with nodeIntegration: true, so the DevTools console is a
// Node REPL with the user's full filesystem rights. In a SHIPPED build that is
// the classic self-XSS route - "open this file, press F12, paste this" - and
// nothing about it requires a bug in Folia to exploit, only a person at the
// keyboard following instructions.
//
// Source runs keep DevTools unconditionally, because that is what it is for. A
// packaged build requires an explicit environment opt-in, which is the point:
// an environment variable cannot be set by talking someone through a keystroke,
// so the social-engineering route closes while the maintainer's route stays
// open. Note this is the INTERIM control - the durable fix is SEC-08
// (contextIsolation plus a preload bridge), after which a console in the
// renderer is no longer a console in Node.
function devToolsAllowed() {
  return !app.isPackaged || process.env.FOLIA_DEVTOOLS === "1";
}

// Electron installs a DEFAULT application menu - File/Edit/View/Window - when
// nothing calls Menu.setApplicationMenu. MEASURED: it is present, and its
// View submenu carries Toggle Developer Tools on Ctrl+Shift+I.
//
// Every window this app creates already calls setMenu(null), which was measured
// (with a positive control) to suppress that accelerator, so the default menu
// is displayed nowhere and reachable nowhere. That makes removing it globally
// inert TODAY and valuable tomorrow: a window added later that forgets
// setMenu(null) would otherwise inherit a Node-privileged console on a stock
// keystroke, which is precisely the kind of omission nobody would notice.
//
// Windows-only fork, so the usual macOS caveat does not apply: Chromium handles
// clipboard and selection shortcuts natively here, and it must, because no
// window has used the application menu for them at any point.
function suppressDefaultApplicationMenu() {
  Menu.setApplicationMenu(null);
}

// ============================================
// POPUP DOCUMENT ESCAPING
//
// The image, mermaid and table popups are built by concatenating
// markdown-derived values into a fresh HTML document that is then loaded into a
// real window. That document is parsed as a full document, so an injected
// <script> executes - these helpers are what stops markdown from reaching it
// (SEC-05/06/07). The popups additionally run without Node integration and
// under a nonce CSP, so an escape that is ever missed is contained rather than
// fatal.
// ============================================

// For text and quoted attribute values in the generated markup.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// For values embedded inside a <script> element. JSON alone is not enough: the
// HTML tokenizer ends a script block at the first `</script`, whatever the
// JavaScript string context, which is exactly how the old template-literal
// escaping was defeated. Escaping `<` as \u003c removes that sequence, and the
// U+2028/U+2029 escapes keep the result a valid JavaScript literal.
function toScriptLiteral(value) {
  return JSON.stringify(String(value == null ? "" : value))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Same problem for a whole object rather than a single string. `<` can only
// occur inside a JSON string, so escaping it as \u003c after stringifying
// keeps the result valid JSON and valid JavaScript while making `</script`
// unrepresentable.
function toJsonLiteral(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// A CSP nonce for the scripts this file generates itself. Regenerated per
// document so a value cannot be predicted and reused by injected markup.
function makeNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Write a generated popup document to a private temp directory.
 *
 * SEC-20 — the previous paths were fixed and guessable
 * (`os.tmpdir()/omnicore-temp-<kind>.html`). On Linux and macOS `os.tmpdir()`
 * is the world-writable `/tmp`, so an unprivileged local process can pre-create
 * that exact path as a symlink; `fs.writeFileSync` follows symlinks, which
 * turns opening a popup into an arbitrary file write as the user.
 * `mkdtempSync` creates a fresh directory with an unpredictable name and 0700
 * permissions, and `flag: "wx"` refuses to write at all if anything is already
 * sitting at the target.
 *
 * It also fixes a plain functional bug that had nothing to do with security:
 * one fixed filename *per popup kind* meant a second mermaid diagram
 * overwrote the first one's file, and whichever popup closed first deleted the
 * file out from under the other.
 *
 * @returns {{dir: string, file: string}} pass to removePopupDocument() on close
 */
function writePopupDocument(kind, htmlContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folia-"));
  const file = path.join(dir, `${kind}.html`);
  fs.writeFileSync(file, htmlContent, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { dir, file };
}

/**
 * Remove a popup's temp directory and everything in it.
 *
 * The whole directory goes, not just the file: it is ours alone, and leaving
 * empty directories behind on every popup close is its own slow leak.
 */
function removePopupDocument(tmp) {
  if (!tmp || !tmp.dir) return;
  try {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  } catch (err) {
    console.error("Error cleaning up popup temp directory:", err);
  }
}

// Content-Security-Policy for the generated popup documents.
//
// This, not the regex filtering below, is the real control. These documents are
// loaded from a temp file, so they run with a file:// origin - and a file://
// document in Electron can read other local files: `fetch('file:///C:/Windows/
// win.ini')` from one of these popups returns 200 with the file body, and an
// outbound POST to an arbitrary host succeeds. So any markup injection that
// executes script is local-file theft plus exfiltration, whether or not Node
// integration is on.
//
// `script-src 'nonce-...'` means only the scripts generated here run: injected
// <script> elements, injected inline handlers such as `<img onerror=...>` and
// `javascript:` URLs are all refused by the browser regardless of whether the
// string filtering below happened to catch them. `connect-src 'none'` stops the
// fetch/XHR read-and-exfiltrate path outright. All four verified by probe.
function popupCsp(nonce, extraImgSrc) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    `img-src data: file:${extraImgSrc ? " " + extraImgSrc : ""}`,
    "font-src file: data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    // No frame-ancestors: it is ignored when the policy is delivered in a
    // <meta> element, and Chromium logs an error for it every time one of
    // these popups opens. It bought nothing anyway - these are top-level
    // Electron windows that nothing can embed, and frame-src 'none' above
    // already stops them embedding anything themselves.
    "object-src 'none'",
  ].join("; ");
}

// Defence in depth for the mermaid popup, which has to interpolate real SVG
// markup and so cannot simply escape it. The primary controls for that window
// are the CSP above and the absence of Node integration; this removes the
// obvious script vectors from a diagram that mermaid's own sanitizer may have
// let through.
function stripActiveSvgContent(svg) {
  // The parser decodes character references at attribute-value time, so
  // `javascript&#58;alert(1)` and `javascript&colon;alert(1)` would both survive
  // a raw `javascript:` match and still execute. Decode the references this
  // filter cares about first.
  const decoded = String(svg == null ? "" : svg)
    .replace(/&colon;/gi, ":")
    .replace(/&#(x)?([0-9a-f]+);?/gi, (match, hex, code) => {
      const n = hex ? parseInt(code, 16) : parseInt(code, 10);
      return n === 58 || n === 9 || n === 10 || n === 13 ? String.fromCharCode(n) : match;
    });
  return decoded
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[\s\S]*?>/gi, "")
    // `<meta http-equiv="refresh">` relocates the popup. The navigation guard in
    // registerPopup() is the control that actually stops it; this keeps the
    // element out of the document in the first place.
    .replace(/<meta[\s\S]*?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, "");
}

// Only local files, `data:image/*` and http(s) sources make sense in the image
// popup. Anything else - notably `javascript:` - is dropped.
//
// Remote share forms are rejected before anything else. On Windows an <img>
// pointing at `\\host\share\x.png`, `//host/share/x.png` or `file://host/...`
// makes Chromium perform an automatic SMB fetch with no user interaction,
// handing the current user's NTLM hash to a host the markdown author chose.
// The renderer's sanitizer hook already strips these, but this helper exists
// precisely so the popup does not depend on that hook being correct.
function safeImageSrc(value) {
  const src = String(value == null ? "" : value).trim();
  if (!src) return "";
  if (/^[\\/]{2}/.test(src)) return ""; // \\host\share and //host/share
  if (/^\\\\\?\\/.test(src)) return ""; // \\?\UNC\... extended form
  if (/^file:\/\/(?!\/)/i.test(src)) return ""; // file://host/share
  if (/^file:\/{4,}/i.test(src)) return ""; // file:////host/share
  // Checked before the scheme rejection below: a bare Windows path such as
  // "C:\pics\a.png" otherwise looks like a URL with the scheme "C:" and was
  // silently dropped.
  if (/^[a-zA-Z]:[\\/]/.test(src)) return src;
  if (/^(?:https?:|file:|data:image\/)/i.test(src)) return src;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return "";
  return src; // relative path
}

// Applied to every popup window so they cannot drift apart again.
//
// `popupKind` is passed through as a process argument so the preload can expose
// only the one API that window legitimately needs: without it every popup gets
// every bridge method, and script that executes in (say) the mermaid popup can
// drive the image popup's save-to-disk path.
const POPUP_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  preload: path.join(__dirname, "popup-preload.js"),
};

// webContents.id -> popup kind, so IPC handlers can verify that a message came
// from the kind of window that is allowed to send it.
const popupKinds = new Map();

function popupWebPreferences(kind) {
  return {
    ...POPUP_WEB_PREFERENCES,
    additionalArguments: [`--popup-kind=${kind}`],
  };
}

// Registers a popup and locks it to the document the main process gave it.
//
// The CSP governs what a document may execute and connect to; it says nothing
// about that document being *replaced*. Attacker-controlled markup can carry
// `<meta http-equiv="refresh">` - directly, or tucked inside an SVG
// <foreignObject> - and relocate the whole popup to a remote page. Chromium has
// no CSP directive for this (`navigate-to` was never implemented), so it has to
// be denied in the main process. It matters more than it looks: the preload
// survives a navigation, so without this the attacker's page inherits
// `popupBridge` and, on the image popup, its write-to-disk method.
//
// `will-navigate` does not fire for the initial `loadFile`/`loadURL`, so every
// navigation reaching this handler is one we did not initiate.
function registerPopup(win, kind) {
  const id = win.webContents.id;
  popupKinds.set(id, kind);
  win.on("closed", () => popupKinds.delete(id));

  const denyNavigation = (event, url) => {
    event.preventDefault();
    console.warn(`Blocked navigation from ${kind} popup to: ${url}`);
  };
  win.webContents.on("will-navigate", denyNavigation);
  win.webContents.on("will-redirect", denyNavigation);
  win.webContents.on("will-frame-navigate", denyNavigation);
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`Blocked window.open from ${kind} popup to: ${url}`);
    return { action: "deny" };
  });

  return win;
}

function isPopupOfKind(webContents, kind) {
  return !!webContents && popupKinds.get(webContents.id) === kind;
}

// ============================================
// WINDOW STATE PERSISTENCE
// Saves/restores window bounds and maximised state between launches.
// File lives in the Electron userData directory so it survives app updates.
// ============================================
const WINDOW_STATE_FILE = path.join(
  app.getPath("userData"),
  "window-state.json",
);

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

let _saveStateTimer = null;
function saveWindowState() {
  if (!mainWindow) return;
  clearTimeout(_saveStateTimer);
  _saveStateTimer = setTimeout(() => {
    try {
      const bounds = mainWindow.getNormalBounds();
      fs.writeFileSync(
        WINDOW_STATE_FILE,
        JSON.stringify({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized: mainWindow.isMaximized(),
        }),
      );
    } catch (_) {
      // non-fatal
    }
  }, 400);
}
const { execFile } = require("child_process");

// Helper modules
const {
  isMermaidFile,
  wrapMermaidContent,
  removeBOM,
  readMarkdownFile,
  isLargeDocument,
  sendIPCResult,
} = require("./file-helpers");

// ============================================
// CONDITIONAL IMPORTS
// ============================================
// PERF-01: electron-updater costs ~175ms to require. It is only reachable in
// packaged builds (see checkForUpdatesOnStartup) and via explicit user action,
// so it is loaded on first use rather than at startup. getAutoUpdater() returns
// null if the module is unavailable, preserving the previous truthiness checks.
let autoUpdater = null;
let autoUpdaterInitialized = false;

function getAutoUpdater() {
  if (autoUpdaterInitialized) return autoUpdater;
  autoUpdaterInitialized = true;
  try {
    autoUpdater = require("electron-updater").autoUpdater;
  } catch (err) {
    console.log("electron-updater not available:", err.message);
    return null;
  }
  configureAutoUpdater(autoUpdater);
  return autoUpdater;
}

// ============================================
// LOGGING
// ============================================
const logFilePath = path.join(app.getPath("userData"), "debug.log");
const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

function log(...args) {
  // Only log in development mode to improve performance
  if (!app.isPackaged) {
    console.log(...args);
  }

  // Always write to file for troubleshooting
  const message = args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg),
    )
    .join(" ");
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  logStream.write(logMessage);
}

log("=== Application started ===");
log("User data path:", app.getPath("userData"));
log("Log file:", logFilePath);

// ============================================
// APPLICATION STATE
// ============================================
let mainWindow = null;
let fileToOpen = null;

// File watching state
let fileWatcher = null;
let watchedFilePath = null;
// Set while the renderer has asked us to stop reporting external changes
// (unsaved edits in progress). Tab switches must not silently undo it.
let watchingPaused = false;
let lastModifiedTime = null;

// ============================================
// WINDOW MANAGEMENT
// ============================================

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    // Restore saved position/size; fall back to 1200×800 centred on first run
    x: savedState ? savedState.x : undefined,
    y: savedState ? savedState.y : undefined,
    width: savedState ? savedState.width : 1200,
    height: savedState ? savedState.height : 800,
    show: false, // Don't show until ready
    title: "Folia",
    backgroundColor: "#f5f5f5",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      backgroundThrottling: true, // Throttle background renderers to save CPU
    },
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });

  // The main window runs with nodeIntegration: true, so a navigation away from
  // index.html hands `require` to whatever loads next. Nothing in the app ever
  // navigates the top frame - index.html is loaded once by loadFile below,
  // which does not fire will-navigate - so every event reaching this handler
  // is one we did not initiate.
  //
  // Reachable without this: <map><area href>, <meta http-equiv="refresh">,
  // window.open, and location assignment from inside an @@@html frame. The
  // renderer's click handler covers only the link-shaped ones. (SEC-11)
  //
  // <form action="https://…"> USED TO HEAD THAT LIST and no longer belongs on
  // it. The claim was "DOMPurify allows form and action by default", which was
  // true when this comment was written and was closed by the same SEC-11 work:
  // renderer.js SANITIZE_CONFIG now carries FORBID_TAGS: ['form'] and
  // FORBID_ATTR: ['action', …], both frozen, so a form never survives
  // sanitization to be submitted. Corrected rather than deleted because the
  // stale version overstated what this handler is still needed FOR, and a
  // reader who removed FORBID_TAGS on the strength of it would reopen the hole
  // in the one layer that is not this one.
  //
  // BUT THIS LAYER HAS A MEASURED HOLE, AND THE COMMENT ABOVE USED TO IMPLY IT
  // DID NOT. A navigation target Chromium cannot PARSE - `HTTPS://host:PORT/p`,
  // the shape a mis-templated port produces - fires NO cancellable event at
  // all: will-navigate, will-redirect and will-frame-navigate were all observed
  // silent for it, and Chromium commits its own `about:blank#blocked` page over
  // this document. Every open tab and unsaved edit goes with it.
  //
  // AND NOTHING IN THE MAIN PROCESS EVER LEARNS WHAT THE TARGET WAS. An earlier
  // draft said "only the non-cancellable did-start-navigation sees it", which
  // implied an observability layer that does not exist. Measured with a
  // did-start-navigation witness attached (test-render-security.js, the N11
  // block): for a PARSEABLE target the witness reports the real URL
  // (`http://probe.invalid/page`) even though will-navigate already denied it,
  // but for the unparseable one it reports `about:blank#blocked` - the page
  // Chromium substituted AFTERWARDS. So there is nothing to preventDefault and
  // nothing to log either; the offending URL is never surfaced to any
  // main-process event at all.
  //
  // So this is a real second layer for every URL that PARSES, and no layer at
  // all for one that does not. What actually closes the unparseable case is the
  // renderer's click delegation being TOTAL (renderer.js, the catch-all arm),
  // plus the capture-phase preventDefault on the table-insert preview, which is
  // the one sanitized-HTML surface outside #viewer. Tracked as N15; do not
  // weaken either of those on the strength of this handler. (SEC-11/N15)
  //
  // Attached before loadFile, matching registerPopup(): loadFile does not fire
  // will-navigate so the order cannot matter today, but "guard, then load" is
  // the order that stays correct if that ever changes.
  // The `url` positional this used to read is @deprecated in Electron's own
  // typings (electron.d.ts, the will-navigate/will-redirect overloads); the
  // details object is the first argument and carries `.url`. preventDefault()
  // would survive the positional being dropped, so the app would keep denying -
  // but the log line would print `undefined`, and that log line is not
  // decorative: it is the only evidence a reader or a probe has that the deny
  // fired at all, and it is what established that the denies were SILENT for
  // the unparseable URL described above. will-frame-navigate below already
  // reads `event.url`, so this also makes the three handlers agree.
  const denyMainNavigation = (event) => {
    event.preventDefault();
    console.warn(`Blocked main-window navigation to: ${event.url}`);
  };
  mainWindow.webContents.on("will-navigate", denyMainNavigation);
  mainWindow.webContents.on("will-redirect", denyMainNavigation);
  // Subframes are the @@@html sandbox iframes. They are loaded from srcdoc,
  // which does not fire this event, so anything that does is the frame trying
  // to relocate itself - to a remote page it could then beacon from, or to a
  // local file it could read. The frames have no allow-same-origin and so are
  // already origin-opaque; this closes the exfiltration half.
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return; // handled by will-navigate above
    event.preventDefault();
    console.warn(`Blocked main-window subframe navigation to: ${event.url}`);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`Blocked window.open from the main window to: ${url}`);
    return { action: "deny" };
  });

  // path.join(__dirname, ...) rather than the bare "index.html" this used to
  // pass. loadFile resolves a relative path against app.getAppPath(), which
  // Electron derives from the directory of the ENTRY SCRIPT - so the app booted
  // correctly only when whatever required this file happened to sit beside
  // index.html. That made the harness layout a load-bearing part of the
  // product: `electron bench/run.js` looked for bench/index.html, got
  // ERR_FILE_NOT_FOUND, and left a blank window in which every renderer symbol
  // was undefined. Silent from the main process, so it cost a full 900s
  // watchdog timeout to diagnose, and it is why every suite had to live at the
  // repo root and why bench.js existed as a one-line shim.
  //
  // __dirname is where main.js actually is, which is what "index.html next to
  // main.js" means. The app now boots the same from any entry point.
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Hide the menu bar.
  //
  // THIS LINE IS A SECURITY CONTROL, not tidying. Electron installs a DEFAULT
  // application menu when nothing calls Menu.setApplicationMenu, and that menu
  // carries View > Toggle Developer Tools on Ctrl+Shift+I. With
  // nodeIntegration: true that shortcut is a Node-privileged console in a
  // shipped build. MEASURED, with a positive control: an identical window
  // WITHOUT this call opens DevTools on a synthesised Ctrl+Shift+I, and this
  // one does not - so setMenu(null) suppresses the accelerator, and deleting
  // the line as dead UI code would silently restore it.
  //
  // suppressDefaultApplicationMenu() below is the belt to this pair of braces:
  // it removes the default menu once, for every window, so a window added
  // later that forgets this call cannot inherit the accelerator either.
  mainWindow.setMenu(null);

  // Show window only when content is ready (prevents flicker)
  mainWindow.once("ready-to-show", () => {
    if (savedState && savedState.isMaximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
  });

  // Persist bounds/maximised state on every move, resize, and close
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("close", saveWindowState);

  // Performance: notify renderer when window is hidden/minimized/restored
  mainWindow.on("hide", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: false,
      });
  });
  mainWindow.on("show", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: true,
      });
  });
  mainWindow.on("minimize", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: false,
      });
  });
  mainWindow.on("restore", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: true,
      });
  });

  // Load file from command line after window loads
  mainWindow.webContents.on("did-finish-load", () => {
    log("Window finished loading. fileToOpen:", fileToOpen);

    if (fileToOpen) {
      openFile(fileToOpen);
      fileToOpen = null;
    }
  });

  // Open DevTools in development (F12 to toggle)
  // mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Check for file changes when window regains focus
  mainWindow.on("focus", () => {
    if (watchedFilePath) {
      checkFileChanges();
    }
  });

  // Register keyboard shortcuts
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control || input.meta) {
      if (input.key === "o" && input.type === "keyDown" && !input.shift) {
        event.preventDefault();
        openFileDialog();
      } else if (input.key === "q" && input.type === "keyDown") {
        event.preventDefault();
        app.quit();
      }
    }

    // DevTools is a Node-privileged console here (see devToolsAllowed). The
    // gate is checked before preventDefault rather than after, so when it is
    // shut F12 is an inert key rather than a swallowed one - with no menu bar
    // there is no default action to suppress in the first place.
    if (input.key === "F12" && input.type === "keyDown") {
      if (devToolsAllowed()) {
        event.preventDefault();
        mainWindow.webContents.toggleDevTools();
      }
    } else if (input.key === "F11" && input.type === "keyDown") {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    } else if (input.key === "Escape" && input.type === "keyDown") {
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
    }
  });
}

// ============================================
// FILE WATCHING
// ============================================

// Debounce helper for file change events
let fileChangeDebounce = null;

function startFileWatching(filePath) {
  // Stop any existing watcher
  stopFileWatching();

  // Explicitly arming the watcher for a file clears any earlier pause, so a
  // stale paused flag cannot leave the new file silently unwatched.
  watchingPaused = false;

  if (!fs.existsSync(filePath)) {
    console.error("Cannot watch non-existent file:", filePath);
    return;
  }

  watchedFilePath = filePath;

  // Get initial modification time
  try {
    const stats = fs.statSync(filePath);
    lastModifiedTime = stats.mtimeMs;
  } catch (err) {
    console.error("Error getting file stats:", err);
    return;
  }

  // Use OS-level fs.watch for instant detection
  try {
    fileWatcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === "rename") {
        // File renamed or deleted
        if (!fs.existsSync(filePath)) {
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send("file-deleted", { path: filePath });
          }
          stopFileWatching();
        }
        return;
      }
      // Debounce 'change' events (editors may fire multiple events rapidly)
      clearTimeout(fileChangeDebounce);
      fileChangeDebounce = setTimeout(() => checkFileChanges(), 150);
    });

    fileWatcher.on("error", (err) => {
      console.error("fs.watch error, falling back to polling:", err.message);
      fileWatcher = null;
      // Fallback to polling every 2 seconds (faster than before)
      fileWatcher = setInterval(() => checkFileChanges(), 2000);
    });

    console.log("Started watching file (OS-level):", filePath);
  } catch (err) {
    console.error("fs.watch not available, using polling:", err.message);
    // Fallback to polling every 2 seconds
    fileWatcher = setInterval(() => checkFileChanges(), 2000);
    console.log("Started watching file (polling):", filePath);
  }
}

function checkFileChanges() {
  if (!watchedFilePath || !fs.existsSync(watchedFilePath)) {
    if (watchedFilePath && !fs.existsSync(watchedFilePath)) {
      // File was deleted
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("file-deleted", { path: watchedFilePath });
      }
      stopFileWatching();
    }
    return;
  }

  try {
    const stats = fs.statSync(watchedFilePath);
    const currentModTime = stats.mtimeMs;

    // Check if file has been modified
    if (currentModTime > lastModifiedTime) {
      console.log("File modified externally:", watchedFilePath);
      lastModifiedTime = currentModTime;

      // Notify renderer about file change
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("file-changed-externally", {
          path: watchedFilePath,
          modifiedTime: currentModTime,
        });
      }
    }
  } catch (err) {
    console.error("Error checking file changes:", err);
  }
}

function stopFileWatching() {
  if (fileWatcher) {
    if (typeof fileWatcher.close === "function") {
      // fs.watch FSWatcher
      try {
        fileWatcher.close();
      } catch (e) {
        /* ignore */
      }
    } else {
      // setInterval fallback
      clearInterval(fileWatcher);
    }
    fileWatcher = null;
    watchedFilePath = null;
    lastModifiedTime = null;
    clearTimeout(fileChangeDebounce);
    fileChangeDebounce = null;
    console.log("Stopped file watching");
  }
}

function pauseFileWatching() {
  if (fileWatcher) {
    if (typeof fileWatcher.close === "function") {
      try {
        fileWatcher.close();
      } catch (e) {
        /* ignore */
      }
    } else {
      clearInterval(fileWatcher);
    }
    fileWatcher = null;
    console.log("Paused file watching");
  }
}

function resumeFileWatching() {
  if (watchedFilePath && !fileWatcher) {
    startFileWatching(watchedFilePath);
    console.log("Resumed file watching");
  }
}

// ============================================
// FILE OPERATIONS
// ============================================

/**
 * The one place the large-document wording lives, so the dialog the main
 * process shows on open and the one the renderer requests on tab switch
 * cannot drift apart.
 * @returns {boolean} true if rendering should proceed
 */
function askAboutLargeDocument(name, seconds) {
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "warning",
    buttons: ["Open anyway", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Large document",
    message: `"${name}" may take about ${seconds} seconds to display.`,
    detail:
      "The window will be unresponsive while it renders. This is an estimate " +
      "based on the document's structure, not just its size - documents with " +
      "large tables take much longer than plain text of the same length.",
  });
  return choice === 0;
}

/**
 * A document the cost model predicts will take a long time to become readable
 * gets the reader a choice rather than a frozen window.
 *
 * The prediction is deliberately CHEAP and deliberately CONSERVATIVE: it is an
 * O(n) character scan costing ~0.2% of the render it is gating, and it errs
 * toward warning early (measured, it never under-predicts a real render by
 * more than 1.01x). See file-helpers.js and bench/BASELINE.md.
 *
 * This is a WARNING, not a refusal. The reader knows things the estimator does
 * not - that the file is the one they need, that they will wait. Refusing
 * outright would make a large document unopenable in the only tool that opens
 * it, so the default button opens it anyway.
 *
 * @param {string} content - Raw markdown
 * @param {string} filePath - Shown to the reader so they know which file
 * @returns {boolean} true if rendering should proceed
 */
function confirmLargeDocument(content, filePath) {
  const { large, estimatedMs } = isLargeDocument(content);
  if (!large) return true;

  const seconds = Math.round(estimatedMs / 1000);
  const name = path.basename(filePath);
  log(`Large document: ${name} predicted at ~${seconds}s to render`);

  if (!askAboutLargeDocument(name, seconds)) {
    log(`Large document open cancelled by user: ${name}`);
    return false;
  }
  return true;
}

// Tabs render lazily, so a file that arrived by multi-select or session
// restore reaches its first render on a tab CLICK, in the renderer, long after
// main.js's open-time guard has had its say. The renderer does its own
// estimate (it loads the same file-helpers) and asks here only to put the
// dialog on the main process, where dialogs belong. Sending the estimate
// rather than the document keeps megabytes off the sync IPC channel.
ipcMain.on("confirm-large-render", (event, data) => {
  const name = data && typeof data.name === "string" ? data.name : "This document";
  const seconds = data && Number.isFinite(data.seconds) ? data.seconds : 0;
  event.returnValue = askAboutLargeDocument(name, seconds);
});

function openFile(filePath) {
  log("Attempting to open file:", filePath);

  if (!fs.existsSync(filePath)) {
    log("ERROR: File not found:", filePath);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("show-error", `File not found: ${filePath}`);
    }
    return;
  }

  // Ensure window is ready
  if (!mainWindow || !mainWindow.webContents) {
    log("ERROR: Window not ready");
    return;
  }

  // Use helper function for reading markdown files
  readMarkdownFile(filePath, (err, data) => {
    if (err) {
      log("ERROR: Error reading file:", err);
      mainWindow.webContents.send(
        "show-error",
        `Error reading file: ${err.message}`,
      );
      return;
    }

    log("File read successfully, sending to renderer");
    if (!confirmLargeDocument(data, filePath)) return;
    mainWindow.webContents.send("file-opened", {
      content: data,
      path: filePath,
      allPaths: [filePath],
    });

    // Start watching the file for external changes
    startFileWatching(filePath);
  });
}

function openFileDialog() {
  dialog
    .showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Markdown Files",
          extensions: ["md", "markdown", "mdown", "mkd", "mkdn"],
        },
        { name: "Mermaid Files", extensions: ["mmd", "mermaid"] },
        { name: "All Files", extensions: ["*"] },
      ],
    })
    .then((result) => {
      if (!result.canceled && result.filePaths.length > 0) {
        const filePaths = result.filePaths;
        const firstFilePath = filePaths[0];

        // Use helper function for reading markdown files
        readMarkdownFile(firstFilePath, (err, data) => {
          if (err) {
            console.error("Error reading file:", err);
            return;
          }

          // Send first file content and all selected paths
          if (!confirmLargeDocument(data, firstFilePath)) return;
          mainWindow.webContents.send("file-opened", {
            content: data,
            path: firstFilePath,
            allPaths: filePaths,
          });

          // Start watching the first file for external changes
          startFileWatching(firstFilePath);
        });
      }
    })
    .catch((err) => {
      console.error("Error opening file:", err);
    });
}

// ============================================
// IPC HANDLERS - File Operations
// ============================================

ipcMain.on("open-file-dialog", () => {
  openFileDialog();
});

// Handle image insert dialog
ipcMain.on("open-image-dialog", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Image",
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"],
      },
    ],
    properties: ["openFile"],
  });

  if (result.canceled || result.filePaths.length === 0) return;

  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const fileName = path.basename(filePath);

  const mimeTypes = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
  };
  const mimeType = mimeTypes[ext] || "image/png";

  try {
    const data = fs.readFileSync(filePath);
    const base64 = data.toString("base64");
    mainWindow.webContents.send("image-selected", {
      base64,
      mimeType,
      fileName,
    });
  } catch (err) {
    console.error("Image read error:", err);
    mainWindow.webContents.send("image-selected", { error: err.message });
  }
});

// Handle direct file path open request from renderer (for markdown links)
ipcMain.on("open-file-path", (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    openFile(filePath);
  } else if (filePath) {
    // File doesn't exist - notify renderer to update recent files
    mainWindow.webContents.send("file-not-found", { path: filePath });
  }
});

// Handle open folder in file explorer request
ipcMain.on("open-folder-in-explorer", (event, filePath) => {
  if (filePath) {
    // shell.showItemInFolder will open the folder and select the file
    shell.showItemInFolder(filePath);
  }
});

// ============================================
// IPC HANDLERS - Export
// ============================================

// Open a file with the system default app; handles WSL2 by converting to Windows path
// SEC-22: `exec` runs its argument through a shell, where a path containing
// `$(...)`, backticks or a backslash escape is interpreted rather than treated
// as text - the surrounding double quotes do not neutralise any of those. The
// path comes from a save dialog, so exploiting it needs the user's own
// cooperation, but there is no reason to accept the risk: `execFile` passes the
// argument vector to the process directly and never constructs a command line
// for a shell to re-parse.
function openFileAfterExport(filePath) {
  if (process.platform === "linux") {
    // In WSL2, use wslpath to get the Windows UNC path, then open with explorer.exe
    execFile("wslpath", ["-w", filePath], (err, winPath) => {
      if (!err && winPath && winPath.trim()) {
        execFile("explorer.exe", [winPath.trim()], (err2) => {
          if (err2) shell.showItemInFolder(filePath);
        });
      } else {
        // Not WSL2 or wslpath unavailable, fall back to xdg-open
        shell.openPath(filePath).then((errMsg) => {
          if (errMsg) shell.showItemInFolder(filePath);
        });
      }
    });
  } else {
    shell.openPath(filePath).then((errMsg) => {
      if (errMsg) shell.showItemInFolder(filePath);
    });
  }
}

ipcMain.on("export-pdf", async (event, data) => {
  try {
    const { currentFileName } = data;

    // Determine default filename
    let defaultFilename = "document.pdf";
    if (currentFileName) {
      const nameWithoutExt = currentFileName.replace(/\.[^/.]+$/, "");
      defaultFilename = `${nameWithoutExt}.pdf`;
    }

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export to PDF",
      defaultPath: defaultFilename,
      filters: [
        { name: "PDF Files", extensions: ["pdf"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return;
    }

    // Ask renderer to switch to light mode so PDF is always captured in light theme
    mainWindow.webContents.send("prepare-for-pdf-export");
    await new Promise((resolve) => ipcMain.once("pdf-export-ready", resolve));

    // Generate PDF from current page
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      marginsType: 1, // Minimum margins
      pageSize: "A4",
      preferCSSPageSize: false,
    });

    // Write PDF to file
    fs.writeFile(result.filePath, pdfData, (err) => {
      if (err) {
        console.error("Error saving PDF:", err);
        mainWindow.webContents.send("pdf-export-result", {
          success: false,
          error: err.message,
        });
      } else {
        console.log("PDF saved successfully:", result.filePath);
        openFileAfterExport(result.filePath);
        mainWindow.webContents.send("pdf-export-result", {
          success: true,
          path: result.filePath,
        });
      }
    });
  } catch (error) {
    console.error("Error exporting PDF:", error);
    mainWindow.webContents.send("pdf-export-result", {
      success: false,
      error: error.message,
    });
  }
});

// Handle markdown file save request from renderer
// Writes to the same file are serialized. Two saves dispatched close together
// (Ctrl+S twice, or Save then Ctrl+S) otherwise run as concurrent
// open-truncate-write sequences against one path, and which one lands last is
// decided by the OS - measured leaving the OLDER content on disk while the
// renderer had correctly adopted the newer one. Chaining per path makes the
// last write issued the last write applied, which is the only ordering a user
// can reason about.
const saveQueues = new Map();

function queueSave(filePath, run) {
  const prior = saveQueues.get(filePath) || Promise.resolve();
  const next = prior.then(run, run);
  saveQueues.set(filePath, next);
  next.finally(() => {
    if (saveQueues.get(filePath) === next) saveQueues.delete(filePath);
  });
  return next;
}

ipcMain.on("save-markdown-file", (event, data) => {
  try {
    const { filePath, content, requestId } = data;
    // Writes are asynchronous and several can be in flight at once, so every
    // reply - including the failures - has to carry enough identity for the
    // renderer to match it to the request that produced it. Without this the
    // renderer cannot tell which document was written, and a save for a
    // background tab gets applied to whatever the user is looking at now.

    if (!filePath) {
      mainWindow.webContents.send("save-markdown-result", {
        success: false,
        error: "No file path provided",
        path: filePath || null,
        requestId: requestId,
      });
      return;
    }

    // Write file to disk
    queueSave(filePath, () => new Promise((done) => {
      fs.writeFile(filePath, content, "utf8", (err) => {
        if (err) {
          console.error("Error saving file:", err);
          mainWindow.webContents.send("save-markdown-result", {
            success: false,
            error: err.message,
            path: filePath,
            requestId: requestId,
          });
        } else {
          console.log("File saved successfully:", filePath);

          // Update lastModifiedTime to prevent false "external change" detection
          if (watchedFilePath === filePath) {
            try {
              const stats = fs.statSync(filePath);
              lastModifiedTime = stats.mtimeMs;
              console.log(
                "Updated lastModifiedTime after save:",
                lastModifiedTime,
              );
            } catch (statErr) {
              console.error("Error updating file stats after save:", statErr);
            }
          }

          mainWindow.webContents.send("save-markdown-result", {
            success: true,
            path: filePath,
            requestId: requestId,
          });
        }
        done();
      });
    }));
  } catch (error) {
    console.error("Error in save handler:", error);
    mainWindow.webContents.send("save-markdown-result", {
      success: false,
      error: error.message,
      path: (data && data.filePath) || null,
      requestId: data && data.requestId,
    });
  }
});

// ============================================
// IPC HANDLERS - File Watching
// ============================================

ipcMain.on("start-file-watching", (event, data) => {
  const { filePath } = data;
  startFileWatching(filePath);
});

ipcMain.on("pause-file-watching", () => {
  watchingPaused = true;
  pauseFileWatching();
});

ipcMain.on("resume-file-watching", () => {
  watchingPaused = false;
  resumeFileWatching();
});

ipcMain.on("stop-file-watching", () => {
  watchingPaused = false;
  stopFileWatching();
});

// The tab overlay (custom-tabs.js) sends this on every tab switch. Without a
// handler the watcher stays pinned to whichever file was opened last, so
// external changes to any other open tab are never reported.
ipcMain.on("set-active-file", (event, filePath) => {
  if (!filePath || watchedFilePath === filePath) {
    return;
  }
  if (watchingPaused) {
    // The renderer paused watching because of unsaved edits. Remember the new
    // target so resume-file-watching arms the right file, but do not re-arm
    // here - that would undo the pause the renderer explicitly asked for.
    watchedFilePath = filePath;
    return;
  }
  startFileWatching(filePath);
});

// Handle file reload request
//
// DELIBERATELY NOT SIZE-GUARDED. This path refreshes a document that is
// already open, which means the reader has already been asked about its cost
// once and said yes. It is also the single most-repeated action in this fork -
// the tabbed refresh workflow exists precisely so that files being rewritten
// underneath you can be re-read constantly - so a confirmation here would fire
// dozens of times in a session for a document the reader already committed to.
// The guard belongs on the paths that OPEN something new, not on the ones that
// re-read something chosen.
ipcMain.on("reload-file", (event, data) => {
  const { filePath } = data;

  if (!fs.existsSync(filePath)) {
    sendIPCResult(mainWindow.webContents, "file-reload-result", false, {
      error: "File not found",
    });
    return;
  }

  // Use helper function for reading markdown files
  readMarkdownFile(filePath, (err, content) => {
    if (err) {
      console.error("Error reloading file:", err);
      sendIPCResult(mainWindow.webContents, "file-reload-result", false, {
        error: err.message,
      });
    } else {
      // Update the last modified time after successful reload
      try {
        const stats = fs.statSync(filePath);
        lastModifiedTime = stats.mtimeMs;
      } catch (statErr) {
        console.error("Error updating file stats:", statErr);
      }

      sendIPCResult(mainWindow.webContents, "file-reload-result", true, {
        content,
        path: filePath,
      });
    }
  });
});

// ============================================
// IPC HANDLERS - Popups
// ============================================

ipcMain.on("open-mermaid-popup", (event, data) => {
  const { svgContent, isDarkMode } = data;

  // Create popup window
  const popupWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#ffffff",
    autoHideMenuBar: true,
    webPreferences: popupWebPreferences("mermaid"),
    title: "Mermaid Diagram - Zoom with mouse wheel, Pan by dragging",
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });

  registerPopup(popupWindow, "mermaid");

  popupWindow.setMenu(null);

  // Create HTML with pan/zoom using matrix transform approach
  const nonce = makeNonce();
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${popupCsp(nonce)}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mermaid Diagram</title>
    <style>
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: ${isDarkMode ? "#1a1a1a" : "#f0f0f0"};
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        .ui-overlay {
            position: absolute;
            top: 20px;
            left: 20px;
            background: ${isDarkMode ? "#2d2d2d" : "white"};
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0,0,0,${isDarkMode ? "0.3" : "0.1"});
            pointer-events: auto;
            z-index: 10;
            border: 1px solid ${isDarkMode ? "#404040" : "transparent"};
        }
        h1 {
            margin: 0 0 10px 0;
            font-size: 16px;
            color: ${isDarkMode ? "#3DBDC6" : "#333"};
        }
        p {
            margin: 0 0 10px 0;
            font-size: 12px;
            color: ${isDarkMode ? "#a0a0a0" : "#666"};
        }
        button {
            padding: 8px 12px;
            background-color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            transition: background 0.2s;
            width: 100%;
            margin-bottom: 8px;
        }
        button:last-child {
            margin-bottom: 0;
        }
        button:hover {
            background-color: ${isDarkMode ? "#4FCDD6" : "#1f8089"};
        }
        button:disabled {
            background-color: ${isDarkMode ? "#555" : "#ccc"};
            cursor: not-allowed;
        }
        #svg-container-wrapper {
            cursor: grab;
            overflow: hidden;
        }
        #svg-container-wrapper:active {
            cursor: grabbing;
        }
        #viewport {
            /* No will-change here, deliberately. Promoting the viewport to its
               own composited layer makes Chromium rasterize the SVG ONCE and
               then scale that bitmap: measured at 600% zoom, glyph edges went
               from crisp vector outlines to a visibly soft upscale. Without the
               hint the transform is still composited, it just re-rasterizes at
               the new scale, which is the whole point of a vector pop-out. */
        }
    </style>
</head>
<body>
    <div class="ui-overlay">
        <h1>Mermaid Diagram</h1>
        <p>• Scroll to Zoom (at cursor)<br>• Click & Drag to Pan</p>
        <button id="resetBtn">Reset View</button>
        <button id="pdfBtn">Save as PDF</button>
    </div>
    <div id="svg-container-wrapper" style="width: 100%; height: 100%; position: relative;">
        <div id="viewport" style="transform-origin: 0 0;">
            ${stripActiveSvgContent(svgContent)}
        </div>
    </div>
    <script nonce="${nonce}">
        const svgWrapper = document.getElementById('svg-container-wrapper');
        const viewport = document.getElementById('viewport');
        const mermaidSvg = viewport.querySelector('svg');

        // Don't extract children - keep the Mermaid SVG intact so styles work
        if (mermaidSvg) {
            mermaidSvg.style.display = 'block';
            mermaidSvg.style.maxWidth = '100%';
            mermaidSvg.style.height = 'auto';
        }
        const svg = svgWrapper; // Treat wrapper as pan/zoom container
        let state = {
            scale: 1,
            panning: false,
            pointX: 0,
            pointY: 0,
            startX: 0,
            startY: 0
        };
        const config = {
            minScale: 0.01,
            maxScale: 10,
            zoomSpeed: 0.1
        };

        // Initial fit to screen
        if (mermaidSvg) {
            const svgRect = mermaidSvg.getBoundingClientRect();
            const wrapperRect = svgWrapper.getBoundingClientRect();
            const scaleX = (wrapperRect.width * 0.9) / svgRect.width;
            const scaleY = (wrapperRect.height * 0.9) / svgRect.height;
            const initialScale = Math.min(scaleX, scaleY, 1);
            state.scale = initialScale;
            state.pointX = (wrapperRect.width - svgRect.width * initialScale) / 2;
            state.pointY = (wrapperRect.height - svgRect.height * initialScale) / 2;
            updateTransform();
        }

        // Mouse wheel zoom
        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const delta = -Math.sign(e.deltaY);
            const zoomFactor = 1 + (config.zoomSpeed * delta);
            let newScale = state.scale * zoomFactor;

            if (newScale < config.minScale) newScale = config.minScale;
            if (newScale > config.maxScale) newScale = config.maxScale;

            const ratio = newScale / state.scale;
            state.pointX = mouseX - (mouseX - state.pointX) * ratio;
            state.pointY = mouseY - (mouseY - state.pointY) * ratio;
            state.scale = newScale;

            updateTransform();
        }, { passive: false });

        // Pan with left mouse button
        function startPan(e) {
            if (e.button !== 0) return;
            e.preventDefault();
            state.panning = true;
            state.startX = e.clientX - state.pointX;
            state.startY = e.clientY - state.pointY;
            svg.style.cursor = 'grabbing';
        }

        function pan(e) {
            if (!state.panning) return;
            e.preventDefault();
            state.pointX = e.clientX - state.startX;
            state.pointY = e.clientY - state.startY;
            updateTransform();
        }

        function endPan(e) {
            state.panning = false;
            svg.style.cursor = 'grab';
        }

        svg.addEventListener('mousedown', startPan);
        window.addEventListener('mousemove', pan);
        window.addEventListener('mouseup', endPan);
        svg.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                state.panning = true;
                state.startX = e.touches[0].clientX - state.pointX;
                state.startY = e.touches[0].clientY - state.pointY;
            }
        }, {passive: false});
        window.addEventListener('touchmove', (e) => {
            if (!state.panning || e.touches.length !== 1) return;
            e.preventDefault();
            state.pointX = e.touches[0].clientX - state.startX;
            state.pointY = e.touches[0].clientY - state.startY;
            updateTransform();
        }, {passive: false});
        window.addEventListener('touchend', endPan);

        function updateTransform() {
            viewport.style.transform = \`translate(\${state.pointX}px, \${state.pointY}px) scale(\${state.scale})\`;
        }
        window.resetView = function() {
            state = {
                scale: 1,
                panning: false,
                pointX: 0,
                pointY: 0,
                startX: 0,
                startY: 0
            };
            updateTransform();
        }

        window.savePDF = async function() {
            const pdfBtn = document.getElementById('pdfBtn');
            const originalText = pdfBtn.textContent;
            pdfBtn.textContent = 'Saving...';
            pdfBtn.disabled = true;

            // Hide UI overlay for PDF
            const overlay = document.querySelector('.ui-overlay');
            overlay.style.display = 'none';

            // Hide the normal view
            svgWrapper.style.display = 'none';

            // Create a clean PDF container with the SVG at proper size
            const pdfContainer = document.createElement('div');
            pdfContainer.id = 'pdf-export-container';
            pdfContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:${isDarkMode ? "#1a1a1a" : "#f0f0f0"};';

            // Clone the SVG
            const svgClone = mermaidSvg.cloneNode(true);

            // Get viewport dimensions
            const pageWidth = window.innerWidth;
            const pageHeight = window.innerHeight;

            // Get SVG natural dimensions
            const viewBox = mermaidSvg.viewBox?.baseVal;
            const naturalWidth = viewBox?.width || parseFloat(mermaidSvg.getAttribute('width')) || 800;
            const naturalHeight = viewBox?.height || parseFloat(mermaidSvg.getAttribute('height')) || 600;

            // Calculate size to fit 85% of page while maintaining aspect ratio
            const maxWidth = pageWidth * 0.85;
            const maxHeight = pageHeight * 0.85;
            const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);

            const finalWidth = naturalWidth * scale;
            const finalHeight = naturalHeight * scale;

            // Set SVG to calculated size (not using CSS transform)
            svgClone.setAttribute('width', finalWidth);
            svgClone.setAttribute('height', finalHeight);
            svgClone.style.maxWidth = 'none';
            svgClone.style.width = finalWidth + 'px';
            svgClone.style.height = finalHeight + 'px';

            pdfContainer.appendChild(svgClone);
            document.body.appendChild(pdfContainer);

            // Small delay to ensure rendering
            await new Promise(resolve => setTimeout(resolve, 200));

            // Request PDF export from main process
            popupBridge.exportMermaidPdf((result) => {
                // Remove PDF container and restore normal view
                pdfContainer.remove();
                svgWrapper.style.display = '';
                overlay.style.display = 'block';

                if (result.success) {
                    pdfBtn.textContent = 'Saved!';
                } else if (result.canceled) {
                    pdfBtn.textContent = originalText;
                    pdfBtn.disabled = false;
                    return;
                } else {
                    pdfBtn.textContent = 'Error!';
                }
                setTimeout(() => {
                    pdfBtn.textContent = originalText;
                    pdfBtn.disabled = false;
                }, 1500);
            });
        }

        // Wired here rather than with inline onclick attributes: the document's
        // CSP allows only nonce-carrying scripts, and an inline handler counts
        // as script the browser cannot verify, so it would never fire.
        document.getElementById('resetBtn').addEventListener('click', () => window.resetView());
        document.getElementById('pdfBtn').addEventListener('click', () => window.savePDF());
    </script>
</body>
</html>`;

  // Write temp HTML file
  const tmpDoc = writePopupDocument("mermaid", htmlContent);

  // Load the HTML file
  popupWindow.loadFile(tmpDoc.file);

  // Clean up temp file after window closes
  popupWindow.on("closed", () => {
    removePopupDocument(tmpDoc);
  });

  // Handle PDF export request from this popup window
  const mermaidPdfHandler = async (ev) => {
    if (BrowserWindow.fromWebContents(ev.sender) !== popupWindow) return;
    try {
      const printOptions = {
        printBackground: true,
        landscape: true,
        pageSize: "A4",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      };

      const pdfData = await popupWindow.webContents.printToPDF(printOptions);

      const result = await dialog.showSaveDialog(popupWindow, {
        title: "Save Mermaid Diagram as PDF",
        defaultPath: path.join(os.homedir(), "mermaid-diagram.pdf"),
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });

      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, pdfData);
        openFileAfterExport(result.filePath);
        popupWindow.webContents.send("mermaid-pdf-result", { success: true });
      } else {
        popupWindow.webContents.send("mermaid-pdf-result", { canceled: true });
      }
    } catch (err) {
      console.error("Mermaid PDF export error:", err);
      popupWindow.webContents.send("mermaid-pdf-result", {
        success: false,
        error: err.message,
      });
    }
  };
  ipcMain.on("mermaid-export-pdf", mermaidPdfHandler);

  popupWindow.on("closed", () => {
    ipcMain.removeListener("mermaid-export-pdf", mermaidPdfHandler);
  });
});

// Handle Image popup request
ipcMain.on("open-image-popup", (event, data) => {
  const { src, alt, isDarkMode } = data;

  const title = alt ? `Image — ${alt}` : "Image Viewer";
  const popupWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#f0f0f0",
    autoHideMenuBar: true,
    webPreferences: popupWebPreferences("image"),
    title,
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });

  registerPopup(popupWindow, "image");

  popupWindow.setMenu(null);

  const bg = isDarkMode ? "#1a1a1a" : "#f0f0f0";
  const uiBg = isDarkMode ? "#2d2d2d" : "#ffffff";
  const uiBorder = isDarkMode ? "#404040" : "transparent";
  const textColor = isDarkMode ? "#e0e0e0" : "#333";
  const accentColor = isDarkMode ? "#3DBDC6" : "#279EA7";
  const accentHover = isDarkMode ? "#4FCDD6" : "#1f8089";
  const subTextColor = isDarkMode ? "#a0a0a0" : "#666";

  const nonce = makeNonce();
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${popupCsp(nonce, "https: http: blob:")}">
  <title>${escapeHtml(alt || "Image Viewer")}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: ${bg};
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    #canvas {
      width: 100%; height: 100%;
      cursor: grab;
      overflow: hidden;
      position: relative;
      display: flex; align-items: center; justify-content: center;
    }
    #canvas:active { cursor: grabbing; }
    #viewport {
      /* will-change is deliberately absent here too - see the mermaid popup for
         the measurement. This viewport is NOT raster-only: safeImageSrc() admits
         data:image/svg+xml and .svg paths, so it carries vector content that
         blurs in exactly the same way. */
      transform-origin: 0 0;
    }
    #viewport img {
      display: block;
      max-width: none;
      user-select: none;
      -webkit-user-drag: none;
    }
    .ui-overlay {
      position: absolute;
      top: 20px; left: 20px;
      background: ${uiBg};
      border: 1px solid ${uiBorder};
      padding: 14px 16px;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,${isDarkMode ? "0.4" : "0.12"});
      z-index: 10;
      min-width: 160px;
    }
    .ui-overlay h1 {
      font-size: 14px;
      font-weight: 600;
      color: ${accentColor};
      margin-bottom: 6px;
    }
    .ui-overlay p {
      font-size: 11px;
      color: ${subTextColor};
      margin-bottom: 10px;
      line-height: 1.5;
    }
    .ui-overlay button {
      display: block;
      width: 100%;
      padding: 7px 10px;
      margin-bottom: 6px;
      background: ${accentColor};
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.18s;
    }
    .ui-overlay button:last-child { margin-bottom: 0; }
    .ui-overlay button:hover { background: ${accentHover}; }
    .ui-overlay button:disabled { opacity: 0.55; cursor: not-allowed; background: ${accentColor}; }
    #zoom-label {
      display: block;
      text-align: center;
      font-size: 12px;
      color: ${textColor};
      margin-bottom: 8px;
      font-weight: 500;
    }
    .btn-secondary {
      background: ${isDarkMode ? "#3a3a3a" : "#e8e8e8"} !important;
      color: ${isDarkMode ? "#e0e0e0" : "#444"} !important;
    }
    .btn-secondary:hover { background: ${isDarkMode ? "#4a4a4a" : "#d4d4d4"} !important; }
    .divider {
      border: none;
      border-top: 1px solid ${isDarkMode ? "#404040" : "#e0e0e0"};
      margin: 8px 0;
    }
  </style>
</head>
<body>
  <div class="ui-overlay">
    <h1>Image Viewer</h1>
    <p>• Scroll to zoom (at cursor)<br>• Drag to pan</p>
    <span id="zoom-label">100%</span>
    <button id="resetBtn">Reset View</button>
    <hr class="divider">
    <button id="btn-png" class="btn-secondary">⬇ Save as PNG</button>
    <button id="btn-jpg" class="btn-secondary">⬇ Save as JPG</button>
  </div>
  <div id="canvas">
    <div id="viewport">
      <img id="the-img" src="${escapeHtml(safeImageSrc(src))}" alt="${escapeHtml(alt || "")}">
    </div>
  </div>
  <script nonce="${nonce}">
    const canvas = document.getElementById('canvas');
    const viewport = document.getElementById('viewport');
    const theImg = document.getElementById('the-img');
    const zoomLabel = document.getElementById('zoom-label');

    let state = { scale: 1, panning: false, pointX: 0, pointY: 0, startX: 0, startY: 0 };
    const MIN_SCALE = 0.05, MAX_SCALE = 20, ZOOM_SPEED = 0.12;

    function updateTransform() {
      viewport.style.transform = \`translate(\${state.pointX}px, \${state.pointY}px) scale(\${state.scale})\`;
      zoomLabel.textContent = Math.round(state.scale * 100) + '%';
    }

    // Fit image to window on load
    theImg.onload = function() {
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const iw = theImg.naturalWidth, ih = theImg.naturalHeight;
      const scale = Math.min(cw * 0.9 / iw, ch * 0.9 / ih, 1);
      state.scale = scale;
      state.pointX = (cw - iw * scale) / 2;
      state.pointY = (ch - ih * scale) / 2;
      updateTransform();
    };

    // Wheel zoom toward cursor
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const delta = -Math.sign(e.deltaY);
      const factor = 1 + ZOOM_SPEED * delta;
      let newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
      const ratio = newScale / state.scale;
      state.pointX = mouseX - (mouseX - state.pointX) * ratio;
      state.pointY = mouseY - (mouseY - state.pointY) * ratio;
      state.scale = newScale;
      updateTransform();
    }, { passive: false });

    // Pan
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      state.panning = true;
      state.startX = e.clientX - state.pointX;
      state.startY = e.clientY - state.pointY;
    });
    window.addEventListener('mousemove', e => {
      if (!state.panning) return;
      e.preventDefault();
      state.pointX = e.clientX - state.startX;
      state.pointY = e.clientY - state.startY;
      updateTransform();
    });
    window.addEventListener('mouseup', () => { state.panning = false; });

    window.resetView = function() {
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const iw = theImg.naturalWidth, ih = theImg.naturalHeight;
      const scale = Math.min(cw * 0.9 / iw, ch * 0.9 / ih, 1);
      state = { scale, panning: false, pointX: (cw - iw * scale) / 2, pointY: (ch - ih * scale) / 2, startX: 0, startY: 0 };
      updateTransform();
    };

    window.saveImage = function(format) {
      const btnId = format === 'jpeg' ? 'btn-jpg' : 'btn-png';
      const btn = document.getElementById(btnId);
      const origText = btn.textContent;
      btn.textContent = 'Saving…';
      btn.disabled = true;

      const offscreen = document.createElement('canvas');
      offscreen.width = theImg.naturalWidth;
      offscreen.height = theImg.naturalHeight;
      const ctx = offscreen.getContext('2d');
      if (format === 'jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, offscreen.width, offscreen.height);
      }
      ctx.drawImage(theImg, 0, 0);
      const dataUrl = offscreen.toDataURL(format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.95);

      popupBridge.saveImage(dataUrl, format, (result) => {
        if (result.success) {
          btn.textContent = 'Saved!';
          setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
        } else if (result.canceled) {
          btn.textContent = origText;
          btn.disabled = false;
        } else {
          btn.textContent = 'Error!';
          setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
        }
      });
    };

    // Listeners rather than inline onclick attributes, which the document's
    // nonce CSP would refuse to run.
    document.getElementById('resetBtn').addEventListener('click', () => window.resetView());
    document.getElementById('btn-png').addEventListener('click', () => window.saveImage('png'));
    document.getElementById('btn-jpg').addEventListener('click', () => window.saveImage('jpeg'));
  </script>
</body>
</html>`;

  const tmpDoc = writePopupDocument("image", htmlContent);
  popupWindow.loadFile(tmpDoc.file);
  popupWindow.on("closed", () => {
    removePopupDocument(tmpDoc);
  });
});

// Handle image save request from image popup
// Largest data URL the image popup may hand back. A rendered image of a
// realistic screenshot is well under this; the cap stops a hostile page from
// making the main process buffer an unbounded string before writing it.
const MAX_IMAGE_DATA_URL_BYTES = 64 * 1024 * 1024;

ipcMain.on("image-popup-save", async (event, { dataUrl, format }) => {
  // Only the image popup may drive this. Without the check any popup that runs
  // script can open a save dialog and write bytes of its choosing.
  if (!isPopupOfKind(event.sender, "image")) return;

  // The payload must be an image data URL produced by canvas.toDataURL, not an
  // arbitrary string: the bytes are decoded and written to disk verbatim.
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_IMAGE_DATA_URL_BYTES) {
    event.reply("image-popup-save-result", {
      success: false,
      error: "Unsupported image data",
    });
    return;
  }
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) {
    event.reply("image-popup-save-result", {
      success: false,
      error: "Unsupported image data",
    });
    return;
  }

  const format2 = format === "jpeg" ? "jpeg" : "png";
  const ext = format2 === "jpeg" ? "jpg" : "png";
  const filterName = format2 === "jpeg" ? "JPEG Image" : "PNG Image";
  const win = BrowserWindow.fromWebContents(event.sender);

  try {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `image.${ext}`,
      filters: [{ name: filterName, extensions: [ext] }],
    });

    if (result.canceled) {
      event.reply("image-popup-save-result", { canceled: true });
      return;
    }

    const buffer = Buffer.from(match[2], "base64");
    // Async: the payload may be up to MAX_IMAGE_DATA_URL_BYTES, and a
    // synchronous write of that size stalls every window in the app.
    await fs.promises.writeFile(result.filePath, buffer);
    event.reply("image-popup-save-result", { success: true });
  } catch (err) {
    event.reply("image-popup-save-result", {
      success: false,
      error: err.message,
    });
  }
});

// ============================================================================
// THE TABLE-POPUP TRUST BOUNDARY.
//
// `tableData` arrives over IPC from a renderer that built it out of a markdown
// document, so both its VALUES and its SHAPE are hostile. The shape matters as
// much as the values, which is not obvious: Tabulator resolves a column
// definition against its own option surface, so keys the SENDER chooses can
// switch off the escaping this boundary would otherwise rely on. Measured in
// the vendored 6.5.2 bundle:
//   - mapDefinitions() fills a key only where the column left it undefined,
//     and formatHeader() tests truthiness. So titleFormatter: "html" - whose
//     formatter is literally "return e.getValue()" - or "" or null defeats any
//     titleFormatter default, without raising a warning.
//   - formatter: "html" switches off CELL escaping the same way. Cells are
//     escaped only because an unset formatter defaults to plaintext ->
//     sanitizeHTML, which is the entire reason SEC-06 passes; a sender-chosen
//     formatter takes that default away. SEC-06's fixture now carries
//     formatter: "html" so this claim is MEASURED - before that, dropping
//     `formatter` from the allow-list would have broken nothing visible.
//     Revert R504.
//   - headerTooltip: true - a BOOLEAN, carrying no markup whatsoever - makes
//     loadTooltip run s.innerHTML = definition.title. No amount of value
//     scrubbing can close that one; only refusing the key can. Tooltip
//     .initializeColumn subscribes to column-mousemove ONLY when some column
//     definition carries headerTooltip, so dropping the key means the sink is
//     never even wired - which is why the suite also FORCES it back on via
//     updateDefinition and proves the escaped title is still inert there.
// So this emits a FRESH object with an allow-listed shape, and drops anything
// the sender added rather than validating it. A deny-list would fail the day a
// Tabulator upgrade adds a key nobody here has read.
//
// WHAT ACTUALLY REACHES HERE FROM A DOCUMENT, measured rather than assumed:
// literal markup in a header does NOT survive the producer. DOMPurify strips
// the dangerous attributes, and extractTableData() then reads the header's
// textContent, which drops any surviving element outright. What DOES arrive is
// markup written as ENTITIES, because that is text at every earlier layer and
// only becomes markup again if something assigns it through innerHTML - which
// is exactly what Tabulator does with a column title. So this boundary is the
// layer that matters for the realistic payload, not a redundant third copy of
// the sanitizer.
//
// TITLES ARE ESCAPED HERE RATHER THAN FORMATTED DOWNSTREAM, and that is the
// architecture rather than an implementation detail. definition.title has at
// least three innerHTML readers in 6.5.2 - the header
// (_formatColumnHeaderTitle), the responsive-collapse panel
// (formatCollapsedData) and the tooltip (loadTooltip) - and a titleFormatter
// reaches only the first. Storing ALREADY-ESCAPED text in `title` closes every
// reader REACHABLE UNDER THIS ALLOW-LISTED SHAPE, because each of them assigns
// through innerHTML and innerHTML renders the escaped bytes back as the
// original characters.
//
// That is a narrower claim than "closes every reader", and the difference
// matters. The bundle also has TEXT-CONTEXT readers, which would paint a
// literal "&lt;" at the user: editableTitle's input.value = definition.title,
// the group-header aria-title setAttribute, and the clipboard-paste header
// matcher's string comparison. Those are out of reach because the ALLOW-LIST
// excludes them, not because of innerHTML. So widening the allow-list later -
// editableTitle, headerTooltip, nested `columns` - regresses this to
// entity-visible headers, and no test would fail. Widen it only together with
// a reader audit.
//
// The raw text goes into `titleDownload`. That is a registered column option
// (registerColumnOption("titleDownload"), so no unknown-option warning) and it
// is what the CSV exporter prefers: generateExportList sets colVisPropAttach
// to "Download" and processColumnGroup reads
// definition["title" + attach] || definition.title. So an exported header
// keeps its original characters while every rendered copy is inert. The JSON
// exporter is unaffected either way - it keys on getTitleDownload(), and
// Column.titleDownload is initialised to null and never assigned from the
// definition, so JSON has always keyed on `field`.
// ============================================================================
function normaliseTablePayload(tableData) {
  const src = tableData && typeof tableData === "object" ? tableData : {};
  const rawColumns = Array.isArray(src.columns) ? src.columns : [];
  const rawRows = Array.isArray(src.data) ? src.data : [];
  const columns = [];
  // The sender's own field names, kept ONLY as lookup keys into its own rows.
  // They never reach Tabulator.
  const lookups = [];
  for (let i = 0; i < rawColumns.length; i++) {
    const c =
      rawColumns[i] && typeof rawColumns[i] === "object" ? rawColumns[i] : {};
    const rawTitle = c.title == null ? "" : String(c.title);
    // U+00A0 for an empty title, and it has to become something non-empty for
    // two measured reasons: _buildColumnHeaderTitle renders title || "&nbsp;"
    // as HTML, and generateCollapsedRowData gates on
    // if (definition.title && field), so an empty title vanishes from the
    // collapse panel altogether. Deliberately NOT the producer's own
    // "Column N": an assertion naming that text would be satisfied by
    // extractTableData OR by this line, which measures a disjunction instead
    // of this boundary. U+00A0 passes through escapeHtml untouched and renders
    // as the blank header a reader already expects.
    const title = rawTitle.trim() === "" ? "\u00A0" : rawTitle;
    lookups.push(
      typeof c.field === "string" || typeof c.field === "number" ? c.field : i,
    );
    columns.push({
      title: escapeHtml(title),
      // The RAW original, not the U+00A0-substituted render title: the
      // substitution exists only so the header and the collapse panel have
      // something to paint, and exporting a non-breaking space where the
      // document had an empty header would be a data change. Falls back to
      // `title` only when rawTitle is "", because processColumnGroup reads
      // definition.titleDownload || definition.title and an empty string is
      // falsy - so "" would silently reach the escaped title anyway.
      //
      // LATENT, deliberately recorded: downloaders.html feeds this raw value
      // to generateHeaderElement, which does th.innerHTML = value. Nothing
      // reaches it today - the popup calls download("csv") and
      // download("json") only - but an "Export HTML" button would turn this
      // field back into live markup inside a file on disk.
      titleDownload: rawTitle || title,
      // Re-keyed by INDEX. Validating the incoming name would only have
      // narrowed a class of problems rather than removing it: a "." is a
      // nested-field lookup, duplicates silently collide, and a name matching
      // no row key blanks the column. The producer already emits col0..colN,
      // so this is a no-op in production.
      field: "col" + i,
      headerFilter: "input",
      headerFilterPlaceholder: "Filter...",
    });
  }
  const data = [];
  for (let r = 0; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || typeof row !== "object") continue;
    // Rebuilt key by key rather than copied, so nothing off the sender's
    // prototype chain and no "__proto__"-shaped key survives into the
    // document. Coercing every value to a string additionally removes the
    // object branches from Tabulator's CSV and clipboard paths, which makes
    // exports deterministic.
    const out = {};
    for (let i = 0; i < columns.length; i++) {
      const key = lookups[i];
      const v = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : "";
      out["col" + i] = v == null ? "" : String(v);
    }
    data.push(out);
  }
  return { columns, data };
}

// Handle Table popup request
ipcMain.on("open-table-popup", (event, data) => {
  const { tableData, isDarkMode } = data || {};
  const safeTableData = normaliseTablePayload(tableData);

  // Create popup window
  const popupWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "Interactive Table - Sort, Filter, Export",
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });

  registerPopup(popupWindow, "table");

  popupWindow.setMenu(null);

  // Read Tabulator files from local directory. `libs/` is a SIBLING of src/,
  // not a child: it holds vendored third-party code with its own LICENSE and
  // .gitattributes pins, so it does not belong inside our own source tree.
  const tabulatorJsPath = path.join(
    __dirname,
    "..",
    "libs",
    "tabulator",
    "tabulator.min.js",
  );
  const tabulatorCssPath = path.join(
    __dirname,
    "..",
    "libs",
    "tabulator",
    "tabulator.min.css",
  );

  const tabulatorJs = fs.readFileSync(tabulatorJsPath, "utf8");
  const tabulatorCss = fs.readFileSync(tabulatorCssPath, "utf8");

  // Create HTML with embedded Tabulator
  const nonce = makeNonce();
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${popupCsp(nonce, "blob:")}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Interactive Table</title>
    <style>
        ${tabulatorCss}

        /* Custom theme to match app colors */
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: ${isDarkMode ? "#1a1a1a" : "#f5f5f5"};
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 20px;
            box-sizing: border-box;
        }

        .header {
            background: ${isDarkMode ? "#2d2d2d" : "white"};
            padding: 20px;
            border-radius: 8px 8px 0 0;
            box-shadow: 0 2px 4px rgba(0,0,0,${isDarkMode ? "0.3" : "0.1"});
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0;
            border: 1px solid ${isDarkMode ? "#404040" : "transparent"};
            border-bottom: none;
        }

        h1 {
            margin: 0;
            font-size: 20px;
            color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
        }

        .controls {
            display: flex;
            gap: 10px;
        }

        button {
            padding: 10px 16px;
            background-color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        button:hover {
            background-color: ${isDarkMode ? "#4FCDD6" : "#1f8089"};
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(${isDarkMode ? "61, 189, 198" : "39, 158, 167"}, 0.3);
        }

        button:active {
            transform: translateY(0);
        }

        .table-wrapper {
            flex: 1;
            background: ${isDarkMode ? "#242424" : "white"};
            border-radius: 0 0 8px 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,${isDarkMode ? "0.3" : "0.1"});
            overflow: hidden;
            display: flex;
            flex-direction: column;
            border: 1px solid ${isDarkMode ? "#404040" : "transparent"};
            border-top: none;
        }

        #data-table {
            flex: 1;
        }

        .info {
            padding: 12px 20px;
            background: ${isDarkMode ? "#2d2d2d" : "#e8e8e8"};
            color: ${isDarkMode ? "#a0a0a0" : "#5a6b7d"};
            font-size: 13px;
            border-bottom: 1px solid ${isDarkMode ? "#404040" : "#d0d0d0"};
        }

        /* Tabulator theme customization */
        .tabulator {
            font-size: 13px;
            border: none;
            background-color: ${isDarkMode ? "#242424" : "white"};
            color: ${isDarkMode ? "#e8e8e8" : "#1F3244"};
        }

        .tabulator .tabulator-header {
            background-color: #1F3244;
            color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            border: none;
        }

        .tabulator .tabulator-header .tabulator-col {
            background-color: #1F3244;
            border-right: 1px solid #3a4a5c;
        }

        .tabulator .tabulator-header .tabulator-col .tabulator-col-content {
            padding: 12px;
        }

        .tabulator .tabulator-header .tabulator-col .tabulator-col-title {
            color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            font-weight: 600;
        }

        .tabulator .tabulator-header .tabulator-col.tabulator-sortable:hover {
            background-color: #2a3a4c;
        }

        .tabulator .tabulator-tableholder .tabulator-table .tabulator-row {
            background-color: ${isDarkMode ? "#242424" : "white"};
            color: ${isDarkMode ? "#e8e8e8" : "#1F3244"};
            border-bottom: 1px solid ${isDarkMode ? "#404040" : "#d0d0d0"};
        }

        .tabulator .tabulator-tableholder .tabulator-table .tabulator-row:hover {
            background-color: ${isDarkMode ? "#2d2d2d" : "#f5f5f5"};
        }

        .tabulator .tabulator-tableholder .tabulator-table .tabulator-row .tabulator-cell {
            padding: 10px 12px;
            border-right: 1px solid ${isDarkMode ? "#404040" : "#e8e8e8"};
        }

        .tabulator .tabulator-footer {
            background-color: ${isDarkMode ? "#2d2d2d" : "#f5f5f5"};
            border-top: 2px solid ${isDarkMode ? "#404040" : "#d0d0d0"};
            padding: 8px;
            color: ${isDarkMode ? "#e8e8e8" : "#1F3244"};
        }

        .tabulator .tabulator-footer .tabulator-page {
            background-color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            color: white;
            border: none;
        }

        .tabulator .tabulator-footer .tabulator-page:hover {
            background-color: ${isDarkMode ? "#4FCDD6" : "#1f8089"};
        }

        .tabulator .tabulator-footer .tabulator-page.active {
            background-color: #1F3244;
        }

        /* Header filter styling */
        .tabulator .tabulator-header-filter input {
            border: 1px solid #d0d0d0;
            padding: 4px 8px;
            border-radius: 4px;
            background: white;
            color: #1F3244;
        }

        .tabulator .tabulator-header-filter input:focus {
            border-color: #279EA7;
            outline: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Interactive Table Viewer</h1>
            <div class="controls">
                <button id="clearFiltersBtn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                    Clear Filters
                </button>
                <button id="exportCsvBtn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Export CSV
                </button>
                <button id="exportJsonBtn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Export JSON
                </button>
            </div>
        </div>
        <div class="table-wrapper">
            <div class="info">
                <strong>Tips:</strong> Click column headers to sort • Type in filter boxes to search • Use pagination at bottom • Export filtered data
            </div>
            <div id="data-table"></div>
        </div>
    </div>

    <script nonce="${nonce}">
        ${tabulatorJs}

        // Initialize Tabulator. toJsonLiteral, not JSON.stringify: table cells
        // come from the markdown document, and JSON.stringify leaves the
        // less-than character untouched, so a cell containing a closing script
        // tag ended this element and everything after it was parsed as markup
        // (the SEC-06 class of bug, in a window that can read local files
        // because it runs from file://).
        const tableData = ${toJsonLiteral(safeTableData)};

        const table = new Tabulator("#data-table", {
            data: tableData.data,
            columns: tableData.columns,
            // NOTE FOR EDITORS: this comment is inside a template literal that
            // builds the popup HTML. Never write a backtick or a dollar-brace
            // interpolation opener in here - either one terminates the literal
            // and the file stops parsing.
            //
            // Column titles arrive ALREADY HTML-ESCAPED from
            // normaliseTablePayload, with the original text preserved in
            // titleDownload for the CSV export. That is why no titleFormatter
            // is configured here.
            //
            // There WAS a columnDefaults: { titleFormatter: "plaintext" } on
            // this line, and it was removed deliberately rather than
            // forgotten. It closed only ONE of the three innerHTML readers of
            // definition.title in 6.5.2 - the header - leaving the
            // responsive-collapse panel and the header tooltip live, both of
            // which were measured injecting markup and applying CSS with that
            // option in force. It was also defeatable from the payload itself,
            // since a per-column titleFormatter outranks a default. Escaping
            // at the boundary closes every reader at once, and re-adding a
            // formatter now would DOUBLE-escape and render entities to the
            // reader.
            //
            // Fields are col0..colN by construction, so nested lookups can
            // never be wanted; turning the separator off also skips a split()
            // per column in setField.
            nestedFieldSeparator: false,
            layout: "fitColumns",
            pagination: true,
            paginationSize: 50,
            paginationSizeSelector: [25, 50, 100, 200, true],
            paginationCounter: "rows",
            movableColumns: true,
            // No resizableColumns option: it is a Tabulator 4.x spelling and
            // is not recognised by 6.x, which validates constructor options and
            // logs a warning for unknown ones. Column resizing is on by default
            // via the per-column "resizable" default, so the option was a no-op
            // that bought a console warning. The 6.x spellings, if ever needed,
            // are resizableColumnFit and resizableColumnGuide.
            responsiveLayout: "collapse",
            headerFilterLiveFilterDelay: 300,
            initialSort: [],
            height: "100%"
        });

        // Export functions
        function exportCSV() {
            table.download("csv", "table-export.csv", {bom: true});
        }

        function exportJSON() {
            table.download("json", "table-export.json");
        }

        function clearFilters() {
            table.clearHeaderFilter();
        }

        // Listeners rather than inline onclick attributes, which this
        // document's nonce CSP would refuse to run.
        document.getElementById('clearFiltersBtn').addEventListener('click', clearFilters);
        document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
        document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);

        // Keyboard shortcut
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                window.close();
            }
        });
    </script>
</body>
</html>`;

  // Write temp HTML file
  const tmpDoc = writePopupDocument("table", htmlContent);

  // Load the HTML file
  popupWindow.loadFile(tmpDoc.file);

  // Clean up temp file after window closes
  popupWindow.on("closed", () => {
    removePopupDocument(tmpDoc);
  });
});

// ============================================
// COMMAND LINE HANDLING
// ============================================

function handleFileArgument(argv) {
  log("handleFileArgument called with argv:", argv);
  log("app.isPackaged:", app.isPackaged);

  // Find the file path in argv - it should be a .md file
  // Skip the executable path and any electron/chromium flags
  let filePath = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    // Skip flags (starting with --)
    if (arg.startsWith("--")) {
      continue;
    }
    // Skip '.' (dev mode current directory)
    if (arg === ".") {
      continue;
    }
    // Check if it's a file path
    if (fs.existsSync(arg)) {
      const ext = path.extname(arg).toLowerCase();
      if (
        [
          ".md",
          ".markdown",
          ".mdown",
          ".mkd",
          ".mkdn",
          ".mmd",
          ".mermaid",
          ".ow",
        ].includes(ext)
      ) {
        filePath = arg;
        break;
      }
    }
  }

  log("Extracted file path:", filePath);

  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    log("File extension:", ext);
    fileToOpen = filePath;
    log("Valid markdown file, setting fileToOpen:", fileToOpen);
    return true;
  } else {
    log("No valid markdown file found in arguments");
  }
  return false;
}

// Check for file argument on first launch
log("Initial process.argv:", process.argv);
handleFileArgument(process.argv);

// macOS: handle file open via Finder / double-click / "Open With"
// Must be registered before app is ready so early open-file events are caught.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  log("open-file event received:", filePath);
  if (!filePath) return;

  if (mainWindow && mainWindow.webContents) {
    // App already running — send directly to renderer (respects unsaved-changes check)
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once("did-finish-load", () => {
        mainWindow.webContents.send("external-file-open-request", { filePath });
      });
    } else {
      mainWindow.webContents.send("external-file-open-request", { filePath });
    }
  } else {
    // App not ready yet — store for did-finish-load
    fileToOpen = filePath;
  }
});

ipcMain.on("request-open-file", (event, data) => {
  const { filePath } = data;
  if (filePath && fs.existsSync(filePath)) {
    openFile(filePath);
  }
});

// ============================================
// SINGLE INSTANCE LOCK & APP LIFECYCLE
// ============================================

// Windows identifies an application by its AppUserModelID, not by its window
// title. Without one set explicitly, a dev run groups under Electron's default
// id and a packaged run relies on the shortcut the installer wrote - so
// taskbar grouping, jump lists, pinning and toast attribution can all name
// something other than Folia even though the title bar reads correctly. Read
// from package.json rather than repeated as a literal, because electron-builder
// writes that same appId into the installer and the shortcut: any drift here
// silently splits one app into two taskbar identities.
//
// Windows-only by design - the call is a documented no-op elsewhere, but
// guarding it keeps the intent legible.
if (process.platform === "win32") {
  try {
    const { appId } = require("../package.json").build;
    if (appId) app.setAppUserModelId(appId);
  } catch {
    // Packaged asar layouts always contain package.json; a failure here must
    // never be the reason the app does not start.
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // User opened a file while app is running
    log("Second instance detected, commandLine:", commandLine);

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      // Handle the file from second instance - send to renderer for unsaved changes check
      if (handleFileArgument(commandLine)) {
        log("File to open from second instance:", fileToOpen);

        // Ensure webContents is ready before sending IPC
        if (mainWindow.webContents.isLoading()) {
          log("WebContents is loading, waiting for did-finish-load");
          mainWindow.webContents.once("did-finish-load", () => {
            log("Sending external-file-open-request after load");
            mainWindow.webContents.send("external-file-open-request", {
              filePath: fileToOpen,
            });
            fileToOpen = null;
          });
        } else {
          log("Sending external-file-open-request immediately");
          mainWindow.webContents.send("external-file-open-request", {
            filePath: fileToOpen,
          });
          fileToOpen = null;
        }
      } else {
        log("No valid file found in command line arguments");
      }
    }
  });

  app.whenReady().then(() => {
    // Before any window exists, so no window can ever see the default menu.
    suppressDefaultApplicationMenu();

    // Set dock icon on macOS (applies in dev mode where the .icns bundle isn't used)
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.setIcon(path.join(__dirname, "..", "assets", "app-icon.png"));
      } catch (e) {
        // Non-fatal: window still opens even if icon file is missing
      }
    }

    // SEC-30 layer 1 (defence in depth): deny every download except the app's
    // own in-memory exports.
    //
    // A download is NOT a navigation, so it is invisible to the will-navigate /
    // will-redirect / will-frame-navigate / setWindowOpenHandler denies in
    // createWindow(), and CSP has no directive that governs one. Measured: an
    // <a download href="http://..."> rendered into #tableInsertPreview - which
    // sits outside #viewer and so is not covered by the renderer's click
    // delegation - issued a live outbound request and fired will-download,
    // while a plain anchor in the same click batch was blocked by will-navigate.
    // This handler runs only once the response has begun, so it stops the file
    // drop, not the request; stripping the download attribute in the sanitizer
    // (renderer.js FORBID_ATTR) is what prevents the request itself.
    //
    // The allow-list is blob: only. The app's sole legitimate download through
    // a webContents session is Tabulator's table export (exportCSV/exportJSON),
    // measured at will-download as blob:file:///<uuid> with mime text/csv and
    // no network. (The auto-updater also downloads, but electron-updater uses
    // its own HTTP stack rather than a session, so it never reaches this
    // handler and is unaffected.)
    //
    // Precise about who can mint a blob: URL, because "document content cannot"
    // is FALSE: an @@@html block runs attacker-authored script, and it can call
    // URL.createObjectURL. What it cannot do is DOWNLOAD one - those frames are
    // pinned to sandbox="allow-scripts" with no allow-downloads, and their
    // opaque origin means a blob they mint is not loadable by the top frame
    // either. The top frame itself runs no document-authored script, so no
    // untrusted blob: URL can reach a download here.
    //
    // No data: allowance is needed: DOMPurify's default ALLOWED_URI_REGEXP does
    // not admit data: on an <a href>, so such an anchor loses its href.
    //
    // defaultSession is the complete surface: main.js creates no partitions and
    // passes no custom session to any of its four BrowserWindow sites, so this
    // one handler covers the main window, all three popups and anything added
    // later. Registered here rather than in createWindow() so a second
    // createWindow() (macOS activate) cannot stack duplicate listeners.
    session.defaultSession.on("will-download", (event, item) => {
      const url = item.getURL();
      if (!isDownloadAllowed(url)) {
        console.warn("Blocked download from document content:", url);
        event.preventDefault();
      }
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// ============================================
// Auto-Updater Configuration
// ============================================

// Only configure auto-updater if it's available
// Portable .exe detection: electron-builder sets PORTABLE_EXECUTABLE_DIR for portable builds.
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
let downloadedUpdatePath = null; // path to downloaded installer, set in update-downloaded event

// Called once by getAutoUpdater() on first use. These handlers used to be
// attached at module load; deferring them is safe because nothing can emit
// before the module they belong to has been required.
function configureAutoUpdater(autoUpdater) {
  // Configure auto-updater
  autoUpdater.autoDownload = false; // Don't download automatically, let user decide
  autoUpdater.autoInstallOnAppQuit = !isPortable; // Pointless for portable builds

  // PRIVACY: electron-updater mints a random UUID, persists it to
  // userData/.updaterId and sends it as `x-user-staging-id` on EVERY update
  // check (AppUpdater.js getUpdateInfoAndProvider / getOrCreateStagingUserId).
  // It exists for staged percentage rollouts, which this project does not use,
  // and it is a stable pseudonymous identifier: it makes every check from this
  // machine linkable to every other one, forever. `computeFinalHeaders` merges
  // `requestHeaders` OVER its own, so overriding it here blanks the value.
  // Measured: it must be "" and not undefined -- undefined reaches
  // setHeader() and throws `value` required, which kills the check outright.
  autoUpdater.requestHeaders = { "x-user-staging-id": "" };

  // Auto-updater event handlers
  autoUpdater.on("checking-for-update", () => {
    log("Auto-updater: Checking for updates...");
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", { status: "checking" });
    }
  });

  autoUpdater.on("update-available", (info) => {
    log(
      "Auto-updater: Update available:",
      info.version,
      isPortable ? "(portable)" : "(installer)",
    );
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "available",
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
      });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    log(
      "Auto-updater: No updates available. Current version:",
      app.getVersion(),
    );
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "not-available",
        currentVersion: app.getVersion(),
      });
    }
  });

  autoUpdater.on("download-progress", (progressObj) => {
    log(`Auto-updater: Download progress: ${progressObj.percent.toFixed(1)}%`);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "downloading",
        percent: progressObj.percent,
        bytesPerSecond: progressObj.bytesPerSecond,
        transferred: progressObj.transferred,
        total: progressObj.total,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    log(
      "Auto-updater: Update downloaded:",
      info.version,
      info.downloadedFile || "",
    );
    downloadedUpdatePath = info.downloadedFile || null;
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "downloaded",
        version: info.version,
      });
    }
  });

  autoUpdater.on("error", (err) => {
    // Silently log errors - don't show to user
    // Common errors: no release on GitHub, network issues, etc.
    log("Auto-updater error (silent):", err.message);
  });
}

// Return current app version to renderer
ipcMain.handle("get-version", () => app.getVersion());

// SEC-09 — RESOLVED BY REMOVAL.
//
// This used to be a "translate-text" IPC handler that sent the reader's
// document, in pieces, to Google's unauthenticated translate_a/single
// endpoint. It was originally moved into the main process so the renderer's
// CSP could be connect-src 'none'; the feature has since been removed
// outright, so no process in this app now makes an outbound request carrying
// document content.

// Return app root path so renderer can construct paths like README.md
ipcMain.handle("get-app-path", () => app.getAppPath());

// Return README.md path — works in dev (next to main.js) and packaged (extraResources)
ipcMain.handle("get-readme-path", () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "README.md");
  }
  return path.join(__dirname, "..", "README.md");
});

// IPC handlers for update actions
ipcMain.on("check-for-updates", () => {
  log("Manual update check requested");
  const updater = getAutoUpdater();
  if (!updater) {
    log("Auto-updater not available");
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "error",
        error: "Auto-updater not available",
      });
    }
    return;
  }
  if (app.isPackaged) {
    // Without a `.catch()` this rejects unhandled if the feed cannot be
    // reached - a network failure, or a repository with no published release
    // yet, which returns 404. Route it through the same status channel the
    // renderer already handles instead of leaving an unhandled rejection.
    Promise.resolve(updater.checkForUpdates()).catch((err) => {
      log("Manual update check failed:", err.message);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("update-status", {
          status: "error",
          error: err.message,
        });
      }
    });
  } else {
    log("Skipping update check in development mode");
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "dev-mode",
        message: "Update check is disabled in development mode",
      });
    }
  }
});

ipcMain.on("download-update", () => {
  log("Download update requested");
  const updater = getAutoUpdater();
  if (updater) {
    updater.downloadUpdate();
  }
});

ipcMain.on("install-update", () => {
  log("Install update requested");
  const updater = getAutoUpdater();
  if (!updater) return;

  if (isPortable && downloadedUpdatePath) {
    // Portable .exe: quitAndInstall() doesn't work.
    // Launch the downloaded NSIS installer via a temp batch script (waits for app to exit first).
    try {
      // SEC-20: this used to be a fixed path in the shared temp directory,
      // written and then executed - a local process that wins that race gets
      // code execution as the user. mkdtempSync gives an unpredictable 0700
      // directory, and "wx" refuses to write if anything is already there.
      const batchDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "folia-update-"),
      );
      const batchPath = path.join(batchDir, "update.bat");
      const batch =
        [
          "@echo off",
          "timeout /t 2 /nobreak > nul",
          `start "" "${downloadedUpdatePath}"`,
          // Step out of the directory before removing it, then use the
          // self-deleting-batch idiom: `(goto) 2>nul` makes cmd release its
          // handle on the script so the whole private directory can go, rather
          // than leaving one behind on every portable update.
          'cd /d "%TEMP%"',
          `(goto) 2>nul & rmdir /s /q "${batchDir}"`,
        ].join("\r\n") + "\r\n";
      fs.writeFileSync(batchPath, batch, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      // spawn with an argument array rather than exec with an interpolated
      // command string: the path never passes through a shell that could
      // re-parse a quote in it. detached + windowsHide replaces `start /min`,
      // so the updater outlives the app.quit() below without a console window.
      const { spawn } = require("child_process");
      spawn("cmd.exe", ["/c", batchPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      log("Portable update: batch script launched, quitting app");
      app.quit();
    } catch (err) {
      log("Portable update batch failed:", err.message);
    }
  } else if (!isPortable) {
    updater.quitAndInstall(false, true);
  }
});

// Check for updates after app is ready (only in production)
function checkForUpdatesOnStartup() {
  if (!app.isPackaged) return;
  const updater = getAutoUpdater();
  if (updater) {
    // Wait a few seconds after app starts before checking for updates
    setTimeout(() => {
      log("Checking for updates on startup...");
      updater.checkForUpdates().catch((err) => {
        log("Error checking for updates:", err.message);
      });
    }, 5000);
  }
}

// Call update check after window is ready
app.on("ready", () => {
  checkForUpdatesOnStartup();
});

// SEC-30 download policy, split out from the will-download listener above so
// the RULE can be asserted directly. Proving the listener end-to-end needs a
// real responding server - will-download only fires once a response has begun,
// so an unresolvable probe host (which is what the suites deliberately use)
// never reaches it. A pure predicate is testable without that, and a listener
// that merely exists is not evidence its policy is right.
//
// blob: only. The app's sole legitimate download through a webContents session
// is Tabulator's table export, measured at will-download as blob:file:///<uuid>,
// text/csv, no network. (electron-updater downloads over its own HTTP stack, not
// a session, so it never reaches the listener.) Untrusted content cannot reach
// this with a blob: URL: the only place document-authored script runs is an
// @@@html frame, which is sandboxed without allow-downloads and has an opaque
// origin, so a blob it mints is neither downloadable by it nor loadable by the
// top frame. Anything else, notably http(s):, is a fetch of remote bytes onto
// the user's disk initiated by document content.
function isDownloadAllowed(url) {
  return typeof url === "string" && url.startsWith("blob:");
}

module.exports = { isDownloadAllowed };
