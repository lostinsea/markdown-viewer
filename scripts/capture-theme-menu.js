// Captures the VIEW -> THEME submenu, which is the one theme surface that no
// assertion and no other capture has ever looked at. The scheme rows, the group
// captions, the separator and the two simultaneous ticks are all built at
// runtime by custom-theme.js, so the only way to see them is to open the real
// menu chain and photograph it.
//
//   npx electron scripts/capture-theme-menu.js
//
// Writes into the gitignored screenshots/ tree. Nothing asserts on the result -
// this is a tier-3 artifact, per the project's testing approach.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

require("../test/test-userdata-isolation");
require("../src/main.js");

const OUT_DIR = path.join(__dirname, "..", "screenshots", "themes");

// One capture per mode so the submenu is seen against both chromes, and one
// under a scheme so the tick really has somewhere to move to.
const SHOTS = [
  { name: "menu-default-light", mode: "light", scheme: null },
  { name: "menu-default-dark", mode: "dark", scheme: null },
  { name: "menu-abyss", mode: "dark", scheme: "abyss" },
];

async function waitForWindow() {
  for (let i = 0; i < 300; i++) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) return win;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no window appeared");
}

// capturePage() returns the PREVIOUS frame byte-identical when the window is
// not foreground, so an unchanged image reads as a clean capture. Same
// mitigation as capture-theme-shots.js: raise the window, let it paint across
// two frames, retry, and DELETE the destination on total failure rather than
// leaving a stale PNG that is indistinguishable from a fresh one.
async function capture(win, dest) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      win.showInactive();
      win.moveTop();
      await win.webContents.executeJavaScript(
        `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      );
      await new Promise((r) => setTimeout(r, 250));
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      if (png && png.length > 0) {
        fs.writeFileSync(dest, png);
        return true;
      }
    } catch (e) {
      /* retry */
    }
  }
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  return false;
}

// Opens the real chain rather than forcing classes onto the panels: the whole
// point is to see what a reader sees, including any overflow or clipping the
// runtime-built scheme rows introduce inside the submenu panel.
const OPEN_MENU = `(() => {
  document.getElementById('menuBtn').click();
  const viewBtn = document.getElementById('viewBtn');
  if (viewBtn) viewBtn.click();
  const item = document.getElementById('customThemeMenuItem');
  if (!item) return 'NO THEME ITEM';
  item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  return item.classList.contains('theme-open') ? 'open' : 'NOT OPEN';
})()`;

const CLOSE_MENU = `(() => { document.body.click(); return true; })()`;

// Both legs go through the PRODUCT's own entry points - a real click on the
// mode row, or setScheme() - rather than writing classes and attributes by
// hand. markActive() is internal and unexported, so the ticks in the capture
// are only trustworthy if the real path is what put them there.
function applyState(mode, scheme) {
  return `(() => {
    const K = window.foliaThemes.SCHEME_KEYS;
    if (${JSON.stringify(!!scheme)}) {
      localStorage.setItem('themeMode', ${JSON.stringify(mode)});
      window.foliaThemes.setScheme(${JSON.stringify(scheme)});
    } else {
      localStorage.removeItem(K.light);
      localStorage.removeItem(K.dark);
      const opt = document.querySelector('.custom-theme-option[data-mode="${mode}"]');
      if (!opt) return 'NO MODE ROW';
      opt.click();
    }
    return (document.body.getAttribute('data-theme') || 'none') +
      '/' + (document.body.classList.contains('dark-mode') ? 'dark' : 'light');
  })()`;
}

app.whenReady().then(async () => {
  let failures = 0;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const win = await waitForWindow();
    win.unmaximize();
    win.setBounds({ x: 30, y: 30, width: 1500, height: 1000 });
    await new Promise((r) => setTimeout(r, 1500));

    for (const shot of SHOTS) {
      await win.webContents.executeJavaScript(CLOSE_MENU);
      await new Promise((r) => setTimeout(r, 150));
      const applied = await win.webContents.executeJavaScript(
        applyState(shot.mode, shot.scheme),
      );
      await new Promise((r) => setTimeout(r, 200));
      const opened = await win.webContents.executeJavaScript(OPEN_MENU);
      await new Promise((r) => setTimeout(r, 300));
      const dest = path.join(OUT_DIR, shot.name + ".png");
      const ok = await capture(win, dest);
      if (!ok || opened !== "open") failures++;
      console.log(
        `${ok && opened === "open" ? "OK  " : "FAIL"} ${shot.name.padEnd(20)} menu=${opened} theme=${applied}`,
      );
    }
    console.log(`${SHOTS.length} menu captures attempted, ${failures} failed`);
    app.exit(failures ? 1 : 0);
  } catch (e) {
    console.error("FAILED: " + (e && e.stack));
    app.exit(1);
  }
});
