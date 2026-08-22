// Captures one screenshot per colour scheme so readability can be JUDGED by
// looking, not asserted by arithmetic. The contrast numbers in test:theme are
// the gate; this is the tier-3 artifact that finds the things a ratio cannot
// express - a keyword that is legible but shouts, a comment that disappears
// into the box, a table border that vanishes against the page.
//
// Output goes to the gitignored screenshots/themes/ directory. Nothing here
// asserts; see test/test-theme.js for the assertions.
//
// Isolate this script's userData profile before main.js exists and before the
// app is ready. See test/test-userdata-isolation.js.
require("../test/test-userdata-isolation");

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

require("../src/main.js");

const OUT = path.join(__dirname, "..", "screenshots", "themes");

// One screen carrying every surface a scheme repaints: prose, a link, inline
// code, a table, a blockquote and a fenced block with a wide spread of token
// classes. Deliberately short enough to fit the capture without scrolling, so
// every scheme is photographed from the same vertical position.
const SAMPLE = [
  "# Readability sample",
  "",
  "Ordinary prose with a [link](https://example.invalid/x), some `inline code`,",
  "and **bold** plus *italic* emphasis for the two weights.",
  "",
  "> A blockquote, which carries its own border and muted foreground.",
  "",
  "| Option | Type | Default | Notes |",
  "| --- | --- | --- | --- |",
  "| `zoom` | number | `1.0` | Scales the document |",
  "| `theme` | string | `default` | Colour scheme id |",
  "",
  "```javascript",
  "// Comment: how legible is this against the box?",
  "import { render } from './engine';",
  "",
  "const LIMIT = 0x1f;",
  "export default class Viewer extends Base {",
  "  constructor({ title = 'untitled', tags = [] }) {",
  "    super();",
  "    this.re = /^[a-z]+(\\d+)?$/gi;",
  "    this.title = `${title} (${tags.length})`;",
  "  }",
  "  async load(url) {",
  "    if (!url) throw new TypeError('url required');",
  "    return render(await fetch(url), { limit: LIMIT, strict: true });",
  "  }",
  "}",
  "```",
  "",
].join("\n");

const SHOTS = [
  ["default-light", "light"],
  ["clarity", "light"],
  ["parchment", "light"],
  ["default-dark", "dark"],
  ["abyss", "dark"],
  ["ember", "dark"],
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForWindow(timeout = 30000) {
  const started = Date.now();
  for (;;) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) return win;
    if (Date.now() - started > timeout) throw new Error("no window appeared");
    await sleep(100);
  }
}

async function waitFor(exec, expr, label, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    if (await exec(expr)) return;
    if (Date.now() - started > timeout) {
      throw new Error("timed out waiting for " + label);
    }
    await sleep(100);
  }
}

// capturePage() returns the PREVIOUS frame byte-identical when the window is
// not foreground, so an unchanged image reads as a clean capture. Recorded
// hazard; the showInactive + moveTop + double-rAF dance is the mitigation that
// was measured to work, and an empty frame is treated as failure rather than
// written out.
async function capture(win, file) {
  for (let attempt = 0; attempt < 4; attempt++) {
    win.showInactive();
    win.moveTop();
    await win.webContents.executeJavaScript(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
    );
    await sleep(250);
    try {
      const img = await win.webContents.capturePage();
      if (!img.isEmpty()) {
        fs.writeFileSync(file, img.toPNG());
        return true;
      }
    } catch (e) {
      /* UnknownVizError under load; retry rather than write a stale frame. */
    }
    await sleep(400);
  }
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return false;
}

async function run() {
  const win = await waitForWindow();
  const exec = (js) => win.webContents.executeJavaScript(js);

  win.unmaximize();
  win.setBounds({ x: 30, y: 30, width: 1280, height: 980 });
  await waitFor(exec, `document.getElementById('viewer')`, "#viewer");
  await waitFor(exec, `!!window.foliaThemes`, "custom-theme.js to initialise");
  await exec(`renderMarkdown(${JSON.stringify(SAMPLE)}, "full")`);
  await waitFor(
    exec,
    `!!document.querySelector('#viewer code .token')`,
    "syntax highlighting",
  );

  fs.mkdirSync(OUT, { recursive: true });
  const written = [];
  for (const [id, mode] of SHOTS) {
    await exec(
      `localStorage.setItem('themeMode', ${JSON.stringify(mode)});` +
        `window.foliaThemes.setScheme(${JSON.stringify(id)});1`,
    );
    const wantAttr = id.startsWith("default-") ? "null" : JSON.stringify(id);
    await waitFor(
      exec,
      `document.body.classList.contains('dark-mode') === ${mode === "dark"} && ` +
        `String(document.body.getAttribute('data-theme')) === String(${wantAttr})`,
      `${id} to apply`,
    );
    await exec(`document.querySelector('.content-wrapper').scrollTop = 0;1`);
    const file = path.join(OUT, `${id}.png`);
    const ok = await capture(win, file);
    written.push(`${ok ? "OK  " : "FAIL"} ${id.padEnd(14)} ${file}`);
    console.log(written[written.length - 1]);
  }

  console.log("\n" + written.length + " scheme captures attempted");
  app.exit(written.some((w) => w.startsWith("FAIL")) ? 1 : 0);
}

app.whenReady().then(() =>
  run().catch((e) => {
    console.error("capture failed:", e && e.stack ? e.stack : e);
    app.exit(1);
  }),
);
