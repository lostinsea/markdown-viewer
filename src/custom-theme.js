/**
 * Custom Theme Selector
 * Replaces the upstream binary Dark Mode toggle with a three-way submenu:
 *   Light | Dark | Follow Desktop
 *
 * Overlay file — safe across upstream merges.
 * Load after renderer.js in index.html.
 *
 * Strategy: keep the original #darkModeToggle hidden but intact so its click
 * handler (which re-renders Mermaid diagrams, etc.) is still
 * called when we need to actually change the theme.  We only trigger it when
 * the desired state differs from the current state.
 */

(function initCustomTheme() {
  "use strict";

  const PREF_KEY = "themeMode"; // 'light' | 'dark' | 'desktop'

  /* Scheme choice is stored PER MODE, not globally - the same shape VS Code
     uses for preferredLightColorTheme / preferredDarkColorTheme, and the only
     one that can answer "Follow Desktop" when the OS flips at dusk. `themeMode`
     itself is left strictly alone: its value domain is a contract read by
     resolveDarkPreference() in renderer.js, which feeds mermaid's startup
     theme and falls through to the OS branch SILENTLY on an unknown value. */
  const SCHEME_KEYS = { light: "themeLightScheme", dark: "themeDarkScheme" };

  /* `base: true` means the scheme IS the stylesheet's default block, so it is
     applied by REMOVING data-theme rather than by setting it. Re-declaring
     those values as a scheme block would be a second copy of the appearance
     test/fixtures/theme-golden.json pins, free to drift from it in silence.
     Every non-base id must have a matching body[data-theme="id"] block in
     src/styles.css and every such block must appear here; test:theme asserts
     BOTH directions, because either half alone permits a dead entry. */
  const SCHEMES = [
    { id: "default-light", label: "Default Light", mode: "light", base: true },
    { id: "clarity", label: "Clarity", mode: "light" },
    { id: "parchment", label: "Parchment", mode: "light" },
    { id: "default-dark", label: "Default Dark", mode: "dark", base: true },
    { id: "abyss", label: "Abyss", mode: "dark" },
    { id: "ember", label: "Ember", mode: "dark" },
  ];

  function baseSchemeFor(mode) {
    return SCHEMES.find((s) => s.mode === mode && s.base);
  }

  /* An absent or unknown id falls back to the mode's base scheme, deliberately
     without complaint: a stored id can outlive the scheme it names (a
     downgrade, or a scheme withdrawn), and the honest answer then is the
     default appearance rather than a half-applied one. The `s.mode === mode`
     term matters - it stops a dark id stored under the light key from being
     applied over a light page.

     THE resolveMode() CALL IS NOT DEFENSIVE PADDING. This function is exported
     on window.foliaThemes, and the value the app actually STORES for the mode
     preference is "desktop" - so schemeFor(storedMode()), the most natural
     composition of two exported functions, hit SCHEME_KEYS["desktop"] ===
     undefined, read the literal localStorage key "undefined", matched no
     scheme, and then returned undefined from baseSchemeFor because no scheme
     carries mode "desktop". Every internal caller happens to resolve first, so
     the product never reached it; applyScheme() would have thrown on
     scheme.base inside a click handler, outside the one try that guards the
     parse-time call. Resolving here makes the exported function total. */
  function schemeFor(mode) {
    const m = resolveMode(mode);
    const stored = localStorage.getItem(SCHEME_KEYS[m]);
    return SCHEMES.find((s) => s.id === stored && s.mode === m) || baseSchemeFor(m);
  }

  function resolveMode(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  /* The stored preference, read through renderer.js's resolveStoredMode() so
     the legacy-'darkMode' migration rule lives in exactly one place. Every
     site below used to hand-roll `localStorage.getItem(PREF_KEY) || "desktop"`,
     which ignores the legacy key that resolveDarkPreference() - the thing that
     decides the dark CLASS - honours; the two then disagree on a legacy-only
     profile and the page wears a light scheme's variables under `.dark-mode`.
     The typeof guard mirrors the one on __foliaExportThemeHeld below: this is
     an overlay file and must degrade rather than throw if renderer.js is
     absent. It cannot be absent in the shipped app (index.html loads
     renderer.js first, both classic scripts), and test:theme asserts the export
     exists so this fallback can never quietly become the live path. */
  function storedMode() {
    return typeof window.resolveStoredMode === "function"
      ? window.resolveStoredMode()
      : localStorage.getItem(PREF_KEY) || "desktop";
  }

  /* data-theme is the ONLY thing a scheme changes, and mermaid is deliberately
     not re-themed with it: getMermaidConfig() takes a boolean and ships two
     fixed 14-key palettes, so a same-mode scheme switch has nothing to tell it
     and no re-render to trigger. That is a scope boundary rather than an
     oversight - and it is the seam that breaks first if mermaid is ever made
     scheme-aware. */
  function applyScheme(mode) {
    /* schemeFor() resolves the mode itself now that it is total (see its
       comment above), so this no longer pre-resolves. The saving is NOT a
       matchMedia call - resolveMode() short-circuits on "light"/"dark", so
       schemeFor(resolveMode(mode)) reached matchMedia exactly once on the
       "desktop" path, the same as now. The win is that schemeFor is no longer
       PARTIAL: it used to return undefined for "desktop", which is the defect
       its own comment describes. */
    const scheme = schemeFor(mode);
    /* An export owns the document's appearance until it has finished
       rasterising. Mirrors the darkModeToggle handler in renderer.js: the
       PREFERENCE has already been written by the caller, so skipping the DOM
       write loses nothing - restoreExportScheme() re-derives it from storage
       when the last export releases the hold. Without this a scheme picked
       from the menu mid-export repaints the page underneath printToPDF. */
    const held = window.__foliaExportThemeHeld;
    if (typeof held === "function" && held()) return scheme;
    if (scheme.base) document.body.removeAttribute("data-theme");
    else document.body.setAttribute("data-theme", scheme.id);
    return scheme;
  }

  /* Applied at PARSE time rather than from init() below, which runs 150 ms
     late: without this the reader watches the first document paint in the
     outgoing scheme and then jump. An inline <script> in index.html would be
     earlier still, but the CSP is `script-src 'self'` and minting a nonce for
     a cosmetic gain is the wrong trade. */
  try {
    if (document.body) applyScheme(storedMode());
  } catch (e) {
    /* localStorage can throw in a partitioned context; a missing scheme is a
       cosmetic loss and must never stop the theme menu from being built. */
  }

  // ─── Apply a theme mode ────────────────────────────────────────────────────

  function applyTheme(mode) {
    const wantDark = resolveMode(mode) === "dark";
    const isDark = document.body.classList.contains("dark-mode");

    localStorage.setItem(PREF_KEY, mode);

    /* Scheme BEFORE the toggle: the click below re-renders, and setting
       data-theme afterwards would paint one frame in the outgoing palette. */
    applyScheme(mode);

    // Delegate to the original toggle so Mermaid side-effects run
    if (wantDark !== isDark) {
      const toggle = document.getElementById("darkModeToggle");
      if (toggle) toggle.click();
    }

    markActive(mode);
  }

  /* Picking a scheme also SWITCHES to its mode, because that is what clicking
     it means to a reader. The one exception is "Follow Desktop": if the OS is
     already resolving to that scheme's mode, the choice is recorded WITHOUT
     dropping the follow-the-desktop behaviour the reader deliberately asked
     for - otherwise choosing a dark scheme at night would silently pin the app
     to dark for good. */
  function setScheme(id) {
    const scheme = SCHEMES.find((s) => s.id === id);
    if (!scheme) return;
    localStorage.setItem(SCHEME_KEYS[scheme.mode], scheme.id);
    const mode = storedMode();
    const keepFollowing = mode === "desktop" && resolveMode(mode) === scheme.mode;
    applyTheme(keepFollowing ? "desktop" : scheme.mode);
  }

  function markActive(mode) {
    const activeMode = mode || storedMode();
    document.querySelectorAll(".custom-theme-option").forEach((el) => {
      el.classList.toggle("active", el.dataset.mode === activeMode);
    });
    /* A scheme row is ticked when it is the stored choice for ITS OWN mode, so
       BOTH groups carry a tick at once and the reader can see what "Follow
       Desktop" will pick at either end of the day. Ticking only the active
       mode's group would make the other group look unset when it is not. */
    document.querySelectorAll(".custom-scheme-option").forEach((el) => {
      const s = SCHEMES.find((x) => x.id === el.dataset.scheme);
      el.classList.toggle("active", !!s && schemeFor(s.mode).id === s.id);
    });
  }

  window.foliaThemes = {
    SCHEMES,
    SCHEME_KEYS,
    schemeFor,
    applyScheme,
    resolveMode,
    storedMode,
    setScheme,
  };


  // ─── Build the replacement submenu ────────────────────────────────────────

  function buildThemeMenuItem() {
    const item = document.createElement("div");
    item.className = "tools-menu-item has-submenu";
    item.id = "customThemeMenuItem";

    const sunSvg = `<svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>`;
    const moonSvg = `<svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>`;
    const monitorSvg = `<svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>`;

    item.innerHTML = `
      <span>Theme</span>
      <span class="submenu-arrow">›</span>
      <div class="tools-submenu" id="customThemeSubmenu">
        <div class="tools-submenu-item custom-theme-option" data-mode="light">${sunSvg} Light</div>
        <div class="tools-submenu-item custom-theme-option" data-mode="dark">${moonSvg} Dark</div>
        <div class="tools-submenu-item custom-theme-option" data-mode="desktop">${monitorSvg} Desktop</div>
      </div>
    `;

    const submenu = item.querySelector("#customThemeSubmenu");

    /* BOTH ROW KINDS DISMISS THE MENU THE SAME WAY, and that is worth one
       function rather than two copies. The pair is not obvious - drop the
       `theme-open` class so the submenu does not linger, then simulate an
       outside click on the next tick so the PARENT dropdown closes through
       the product's own dismissal path - and two copies of a non-obvious pair
       is exactly the shape that has silently diverged elsewhere in this file.
       The deferral is load-bearing: clicking the body synchronously inside a
       click handler that has already called stopPropagation would be handled
       before the current event finishes unwinding. */
    function closeMenu() {
      item.classList.remove("theme-open");
      setTimeout(() => document.body.click(), 10);
    }

    /* Scheme rows are built as DOM nodes with textContent rather than appended
       as markup. The labels are static today, so this is not a sanitisation
       fix - it is the convention SEC-13/14 established for every menu surface,
       so a future label drawn from a document or a user file cannot become the
       one innerHTML sink nobody thought to check. */
    const sep = document.createElement("div");
    sep.className = "tools-menu-separator theme-scheme-sep";
    submenu.appendChild(sep);

    for (const groupMode of ["light", "dark"]) {
      const head = document.createElement("div");
      head.className = "theme-scheme-group";
      head.textContent = groupMode === "light" ? "Light schemes" : "Dark schemes";
      submenu.appendChild(head);

      SCHEMES.filter((s) => s.mode === groupMode).forEach((s) => {
        const row = document.createElement("div");
        row.className = "tools-submenu-item custom-scheme-option";
        row.dataset.scheme = s.id;
        row.textContent = s.label;
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          setScheme(s.id);
          closeMenu();
        });
        submenu.appendChild(row);
      });
    }

    // ── JS-controlled hover with a grace-period delay ──────────────────────
    // Pure CSS :hover fires the submenu close the instant the mouse crosses
    // the 4 px gap between the parent item and the submenu panel.
    // Using mouseenter/mouseleave + a 200 ms timeout gives the user time to
    // move diagonally without the panel vanishing.
    let hideTimer = null;

    function showSubmenu() {
      clearTimeout(hideTimer);
      item.classList.add("theme-open");
    }

    function scheduleHide() {
      hideTimer = setTimeout(() => item.classList.remove("theme-open"), 200);
    }

    item.addEventListener("mouseenter", showSubmenu);
    item.addEventListener("mouseleave", scheduleHide);
    submenu.addEventListener("mouseenter", showSubmenu); // keep open while inside panel
    submenu.addEventListener("mouseleave", scheduleHide);

    item.querySelectorAll(".custom-theme-option").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        applyTheme(opt.dataset.mode);
        closeMenu();
      });
    });

    return item;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    const originalToggle = document.getElementById("darkModeToggle");
    if (!originalToggle || document.getElementById("customThemeMenuItem"))
      return;

    // Hide the upstream toggle — our submenu replaces it in the UI
    originalToggle.style.display = "none";

    // Insert the new submenu item right before the hidden toggle
    const themeMenuItem = buildThemeMenuItem();
    originalToggle.parentNode.insertBefore(themeMenuItem, originalToggle);

    // React to OS theme changes when the user has chosen "Follow Desktop"
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (storedMode() === "desktop") {
          applyTheme("desktop");
        }
      });

    // Restore the saved preference. storedMode() performs the legacy 'darkMode'
    // migration that used to be spelled out here, so this is now the same
    // resolution every other site uses rather than a fifth copy of it.
    applyTheme(storedMode());
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(init, 150);
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
