// Regression harness for the theme system: the two DEFAULT schemes must look
// exactly as Folia looked before the theme system existed.
//
// That is a user requirement, not a nicety - "make sure current themes also
// bundle up as Dark/Light defaults" - so the oracle is a FROZEN BASELINE
// captured from the tree at commit 4bbde83, before any of the refactor landed.
// test/fixtures/theme-golden.json is committed literal data produced by
// scripts/capture-theme-golden.js, by hand, deliberately. It is NEVER
// regenerated from a test run: if it were, changing a colour would rewrite the
// file this suite reads, the assertion could not fail, and the revert proof
// would come back VACUOUS.
//
// It records the FULL VISUAL TUPLE rather than colour alone. That is a measured
// requirement: `entity` is separated from `operator` only by its background and
// cursor, and `namespace` from `tag` only by opacity, so a colour-only baseline
// lets both regress green. It also records the code box (padding, radius,
// tab-size, white-space...) because every one of those used to come from the
// vendored light Solarized stylesheet and DARK MODE DEPENDED ON IT - dropping
// that <link> without porting them would have degraded both themes silently.
//
// THE AMENDMENTS TABLE IS THE OTHER HALF OF THE DESIGN. Three dark-mode cells
// are deliberately NOT reproduced, because the old dark block overrode `color`
// only and the light stylesheet leaked everything else into dark mode. Each is
// listed below with a reason and its new expected value. The golden itself is
// never edited, so it stays a faithful record of what shipped - and a FOURTH
// deviation, which nobody decided on, fails loudly instead of hiding among
// three that were.
// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const {
  GOLDEN_PATH,
  TOKEN_PROPS,
  BOX_PROPS,
  SURFACE_SELECTORS,
  waitForWindow,
  captureBothModes,
} = require("./theme-census");

const results = [];
let failed = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  -> " + detail}`,
  );
}

function finish() {
  results.push(`=== ${results.length - failed}/${results.length} passed ===`);
  const text = results.join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "test-theme-results.txt"), text);
  console.log(text);
  app.exit(failed === 0 ? 0 : 1);
}

const watchdog = setTimeout(() => {
  check("harness completed within 180s", false, "watchdog fired");
  finish();
}, 180000);

// ─── THE AMENDMENTS ─────────────────────────────────────────────────────────
// Keyed mode -> token class-set -> property -> { was, now, why }. `was` is
// asserted against the golden too, so an amendment whose premise has changed
// (the old value is no longer what the golden records) fails rather than
// silently excusing whatever is there now.
const TOKEN_AMENDMENTS = {
  dark: {
    "entity.named-entity@": {
      backgroundColor: {
        was: "rgb(238, 232, 213)",
        now: "rgb(58, 58, 58)",
        why: "Solarized base2 cream, a LIGHT swatch painted behind entities on a dark page. It leaked in because the dark block overrode color only.",
      },
    },
    // Three keys, one decision. The census key carries the ancestor token chain,
    // so a namespace inside a tag, inside an attr-name, and bare are separate
    // cells - which is the whole point, since in LIGHT mode those three have
    // three different colours. The opacity amendment applies to all of them.
    "namespace@tag>tag": { opacity: NAMESPACE_OPACITY_AMENDMENT() },
    "namespace@tag>attr-name": { opacity: NAMESPACE_OPACITY_AMENDMENT() },
    "namespace@": { opacity: NAMESPACE_OPACITY_AMENDMENT() },
  },
};

function NAMESPACE_OPACITY_AMENDMENT() {
  return {
    was: "0.7",
    now: "1",
    why: "Solarized dims namespaces to .7 and index.html linked ONLY that light file; the dark block declared no opacity rule at all, so the .7 was never a dark-theme decision. Full opacity is.",
  };
}

// BOX_AMENDMENTS is EMPTY, deliberately, and that is a decision rather than an
// omission. It used to hold one entry: dark `preCode` background
// rgb(45,45,45) -> transparent, on the reasoning that the <code> was repainting
// the identical colour already behind its <pre>. That reasoning is true for a
// HIGHLIGHTED block, where `pre[class*=language-]` carries --code-bg, and FALSE
// for a <pre><code> PrismJS never touches: nothing paints that <pre>, so the
// <code> WAS the dark panel. `--code-pre-code-bg` restores it per mode, which
// makes the highlighted case byte-exact too and leaves nothing to amend.
// DECIDED_AMENDMENTS below is what stops this emptiness from being silent.
const BOX_AMENDMENTS = {};

// ::selection is not on any element, so it is amended as a cascade rule rather
// than a token tuple. The old value was Solarized navy in BOTH modes, which is
// very nearly invisible against the #2d2d2d dark code background.
const DARK_CODE_SELECTION = {
  was: "rgb(7, 54, 66)",
  now: "rgba(61, 189, 198, 0.35)",
};

// THE LEDGER, and it exists because every "applied exactly the decided
// amendments" assertion is structurally unfailable for a mode/part with no
// declared amendment: it compares [] against []. That is harmless while the
// tables are believed correct and worthless as a guard - emptying a table, or
// never adding an entry for a whole mode, is invisible.
//
// So the tables are pinned to the DECISION rather than to themselves. These are
// coordinates (mode/key.property), not decisions: the three namespace keys are
// one decision recorded three times, because the census key carries the
// ancestor token chain.
const DECIDED_AMENDMENTS = [
  "dark/entity.named-entity@.backgroundColor",
  "dark/namespace@.opacity",
  "dark/namespace@tag>attr-name.opacity",
  "dark/namespace@tag>tag.opacity",
  "dark/::selection.background",
];

function declaredAmendmentCoords() {
  const out = [];
  for (const [mode, keys] of Object.entries(TOKEN_AMENDMENTS)) {
    for (const [key, props] of Object.entries(keys)) {
      for (const prop of Object.keys(props)) out.push(`${mode}/${key}.${prop}`);
    }
  }
  for (const [mode, parts] of Object.entries(BOX_AMENDMENTS)) {
    for (const [part, props] of Object.entries(parts)) {
      for (const prop of Object.keys(props)) out.push(`${mode}/box:${part}.${prop}`);
    }
  }
  if (DARK_CODE_SELECTION) out.push("dark/::selection.background");
  return out.sort();
}

function amendmentFor(mode, key, prop) {
  const m = TOKEN_AMENDMENTS[mode];
  return m && m[key] && m[key][prop];
}

// The exact tree the baseline was measured from. Pinned by VALUE, not by shape:
// checking only that it is 40 hex characters asks "is this a commit id?" when
// the question is "is this THE commit?". A golden regenerated against the
// changed tree and stamped with any plausible sha would have passed the shape
// check, and every revert R259-R265 would have gone VACUOUS behind it.
const BASELINE_COMMIT = "4bbde83aa92a1c1a360925b183308b477254667b";

require("../src/main.js");

app.whenReady().then(async () => {
  try {
    const win = await waitForWindow(BrowserWindow);
    const exec = (js) => win.webContents.executeJavaScript(js);

    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

    // ─── 0. The baseline must be the pre-refactor one ───────────────────────
    // A golden generated from the tree it guards is circular, so its
    // independence has to be checkable rather than trusted.
    check(
      "the golden was captured from the pinned baseline commit",
      golden.capturedFromCommit === BASELINE_COMMIT,
      `${golden.capturedFromCommit} (expected ${BASELINE_COMMIT})`,
    );
    // AN INTRINSIC GATE, because the commit stamp is still just a claim made by
    // whoever ran the capture. This one is a property OF THE DATA: before the
    // refactor the code ::selection colour came from the vendored stylesheet and
    // was recorded as a literal `background: rgb(7, 54, 66)`. In the current
    // tree the very same rule serialises as `background: var(--code-selection-bg)`.
    // So a golden whose code ::selection is baked cannot have been produced by
    // the token system - no honest re-capture of the post-refactor tree can
    // forge it.
    const bakedSel = (golden.light.selection || []).filter(
      (r) => /language-/.test(r.selector) && !/var\(/.test(r.css),
    );
    check(
      "the golden predates the token system (its code ::selection is a baked colour, not a var)",
      bakedSel.length > 0,
      JSON.stringify((golden.light.selection || []).map((r) => r.css)),
    );
    check(
      "the golden is non-trivial (>= 40 token keys per mode)",
      Object.keys(golden.light.tokens).length >= 40 &&
        Object.keys(golden.dark.tokens).length >= 40,
      `${Object.keys(golden.light.tokens).length} light / ${Object.keys(golden.dark.tokens).length} dark`,
    );
    // Folded up from what used to be 26 separate "was measured in the golden"
    // checks. Those compared committed data to committed data - they could not
    // respond to any change under src/ - so they inflated the assertion count
    // without measuring the app. One structural gate says the same thing.
    const nullRecords = [];
    for (const mode of ["light", "dark"]) {
      for (const [part, v] of Object.entries(golden[mode].box)) {
        if (!v || typeof v !== "object") nullRecords.push(`${mode}.box.${part}`);
      }
      for (const [sel, v] of Object.entries(golden[mode].surfaces)) {
        if (!v || typeof v !== "object")
          nullRecords.push(`${mode}.surfaces.${sel}`);
      }
    }
    check(
      "every box and surface the golden claims to record is actually recorded",
      nullRecords.length === 0,
      `null (selector matched nothing, asserts nothing): ${nullRecords.join(", ")}`,
    );
    // THE CENSUS'S OWN LISTS, PINNED FROM OUTSIDE THE CENSUS.
    //
    // The shape gate below compares the golden against TOKEN_PROPS / BOX_PROPS /
    // SURFACE_SELECTORS - but those are imported from theme-census.js, WHICH
    // ALSO DRIVES THE CAPTURE. Delete a property there and re-capture and the
    // probe measures less, the golden records less, the gate compares less, and
    // every assertion in this file still passes. Re-capture is not a
    // hypothetical path: this golden has been re-captured five times, and the
    // recipe for doing it is written down.
    //
    // That is this suite's recurring defect for the third time - AN EXPECTATION
    // DRAWN FROM THE THING UNDER TEST IS NOT AN EXPECTATION. (First: the token
    // comparison iterated the golden's own property list. Second: the
    // attribution names existed in two places, so trimming one left all four
    // present and the revert came back vacuous.) The remedy has been the same
    // every time: take the subject list from a source that does not move when
    // the subject moves.
    //
    // So these are a SECOND, INDEPENDENT copy living in the asserting file.
    // Editing theme-census.js alone now fails here; widening or narrowing the
    // census means editing both, and that second edit IS the decision being
    // recorded. Sorted, so a reordering of either list is not a failure.
    const PINNED_TOKEN_PROPS = [
      "backgroundColor",
      "color",
      "cursor",
      "fontStyle",
      "fontWeight",
      "opacity",
    ];
    const PINNED_BOX_PROPS = [
      "backgroundColor",
      "borderBottomColor",
      "borderBottomStyle",
      "borderBottomWidth",
      "borderLeftColor",
      "borderLeftStyle",
      "borderLeftWidth",
      "borderRadius",
      "borderRightColor",
      "borderRightStyle",
      "borderRightWidth",
      "borderTopColor",
      "borderTopStyle",
      "borderTopWidth",
      "boxShadow",
      "color",
      "fontFamily",
      "fontSize",
      "hyphens",
      "lineHeight",
      "margin",
      "overflow",
      "overflowWrap",
      "padding",
      "tabSize",
      "textAlign",
      "textShadow",
      "whiteSpace",
      "wordBreak",
      "wordSpacing",
    ];
    const PINNED_SURFACES = {
      body: ["backgroundColor", "color"],
      "#viewer": ["color"],
      "#viewer h1": ["borderBottomColor", "color"],
      "#viewer h2": ["borderBottomColor", "color"],
      "#viewer p": ["color"],
      "#viewer a": ["color"],
      "#viewer blockquote": ["backgroundColor", "borderLeftColor", "color"],
      "#viewer th": ["backgroundColor", "borderBottomColor", "color"],
      "#viewer td": ["backgroundColor", "color"],
      "#viewer tbody tr:first-child td": ["borderBottomColor"],
    };
    const sortedJSON = (a) => JSON.stringify(a.slice().sort());
    check(
      "the census measures exactly the token properties this suite pins",
      sortedJSON(TOKEN_PROPS) === sortedJSON(PINNED_TOKEN_PROPS),
      `census=${sortedJSON(TOKEN_PROPS)} pinned=${sortedJSON(PINNED_TOKEN_PROPS)} - narrowing the census and re-capturing would shrink coverage with every assertion still green, so the two lists are kept deliberately redundant`,
    );
    check(
      "the census measures exactly the code-box properties this suite pins",
      sortedJSON(BOX_PROPS) === sortedJSON(PINNED_BOX_PROPS),
      `census=${sortedJSON(BOX_PROPS)} pinned=${sortedJSON(PINNED_BOX_PROPS)}`,
    );
    {
      const shape = (o) =>
        JSON.stringify(
          Object.keys(o)
            .sort()
            .map((k) => [k, o[k].slice().sort()]),
        );
      check(
        "the census measures exactly the reading surfaces this suite pins",
        shape(SURFACE_SELECTORS) === shape(PINNED_SURFACES),
        `census=${shape(SURFACE_SELECTORS)} pinned=${shape(PINNED_SURFACES)}`,
      );
    }
    // THE GOLDEN'S SHAPE, not just its size. The token comparison in section 2
    // iterates `Object.entries(want)` - the GOLDEN's own property list - so a
    // record that lost properties compares fewer of them and passes, and a
    // record that lost all of them compares nothing at all. Neither the key
    // count (>= 40) nor section 1's key symmetry can see inside a record.
    // Section 3 already gates the box records this way, and its comment records
    // that the hole "already bit once when BOX_PROPS gained border/box-shadow";
    // tokens, boxes-as-a-set and surfaces never got the same treatment. The
    // expectation is the census's OWN exported constants, so widening the probe
    // without re-capturing fails here rather than silently measuring less.
    const shapeGaps = [];
    for (const mode of ["light", "dark"]) {
      const wantProps = JSON.stringify(TOKEN_PROPS.slice().sort());
      for (const [key, rec] of Object.entries(golden[mode].tokens)) {
        if (JSON.stringify(Object.keys(rec).sort()) !== wantProps) {
          shapeGaps.push(
            `${mode}.tokens[${key}] has ${JSON.stringify(Object.keys(rec).sort())}`,
          );
        }
      }
      for (const [part, rec] of Object.entries(golden[mode].box)) {
        const miss = BOX_PROPS.filter((p) => !rec || !(p in rec));
        if (miss.length) shapeGaps.push(`${mode}.box.${part} lacks ${miss.join(",")}`);
      }
      for (const [sel, props] of Object.entries(SURFACE_SELECTORS)) {
        const rec = golden[mode].surfaces[sel];
        if (!rec) {
          shapeGaps.push(`${mode}.surfaces.${sel} MISSING`);
          continue;
        }
        const miss = props.filter((p) => !(p in rec));
        if (miss.length) shapeGaps.push(`${mode}.surfaces.${sel} lacks ${miss.join(",")}`);
      }
    }
    check(
      "every golden record carries every property the census measures",
      shapeGaps.length === 0,
      `${shapeGaps.slice(0, 8).join(" | ")}${shapeGaps.length > 8 ? ` (+${shapeGaps.length - 8})` : ""} - a record missing a property is compared for the properties it still has and passes for the rest`,
    );

    /* STASH THE WELCOME SCREEN BEFORE ANYTHING RENDERS OVER IT.
       `.welcome` is #viewer's INITIAL content and every render path replaces
       #viewer's children - measured directly: 1 `.welcome` before a render and
       0 after. The census below renders a document, so from that moment on the
       whole --welcome-* surface family is absent from the DOM and any probe
       that walks querySelectorAll('*') is scanning a page that cannot contain
       it. Section 10 re-attaches this markup for its scheme scans. */
    const welcomeStash = await exec(`(() => {
      const w = document.querySelector('#viewer > .welcome');
      if (!w) return 0;
      window.__foliaWelcomeHTML = w.outerHTML;
      return w.querySelectorAll('*').length;
    })()`);
    check(
      "the welcome screen was captured before the first render replaced it",
      welcomeStash > 20,
      `${welcomeStash} nodes captured - section 10 re-attaches this markup to reach the --welcome-* surfaces, which no post-render DOM contains, so a failure here silently empties that coverage`,
    );

    const now = await captureBothModes(win);

    // ─── 1. The census still measures something ─────────────────────────────
    // A probe that matches nothing compares {} to {} and passes. Coverage is
    // asserted against the golden's own size, a measured relationship, rather
    // than a hand-picked floor that decays into a description of the status quo.
    // SYMMETRIC in both directions: a key that disappears means the fixture
    // stopped exercising a rule, and a key that APPEARS is a context the golden
    // never measured, which would otherwise be accepted silently whatever colour
    // it rendered.
    for (const mode of ["light", "dark"]) {
      const g = Object.keys(golden[mode].tokens);
      const n = Object.keys(now[mode].tokens);
      check(
        `${mode}: every token key in the golden still renders`,
        g.every((k) => n.includes(k)),
        `missing: ${g.filter((k) => !n.includes(k)).join(", ") || "none"}`,
      );
      check(
        `${mode}: no token key appears that the golden never measured`,
        n.every((k) => g.includes(k)),
        `unmeasured: ${n.filter((k) => !g.includes(k)).join(", ") || "none"}`,
      );
    }

    // ─── 2. Token tuples reproduce the golden, amendments aside ─────────────
    // The amendment tables are pinned to the recorded DECISION before they are
    // used as an oracle. Without this, "applied exactly the decided amendments"
    // is satisfied by a table that has been emptied, since it then compares an
    // empty observed list against an empty declared list.
    {
      const declared = declaredAmendmentCoords();
      const decided = DECIDED_AMENDMENTS.slice().sort();
      check(
        "the amendment tables declare exactly the decided deviations",
        JSON.stringify(declared) === JSON.stringify(decided),
        `declared=${JSON.stringify(declared)} decided=${JSON.stringify(decided)}`,
      );
    }
    for (const mode of ["light", "dark"]) {
      const diffs = [];
      const amended = [];
      for (const [key, want] of Object.entries(golden[mode].tokens)) {
        const got = now[mode].tokens[key];
        if (!got) continue; // reported by section 1
        for (const [prop, wantVal] of Object.entries(want)) {
          const gotVal = got[prop];
          if (gotVal === wantVal) continue;
          const am = amendmentFor(mode, key, prop);
          if (am && am.was === wantVal && am.now === gotVal) {
            amended.push(`${key}.${prop}`);
            continue;
          }
          diffs.push(`${key}.${prop}: golden=${wantVal} now=${gotVal}`);
        }
      }
      check(
        `${mode}: token appearance reproduces the golden exactly`,
        diffs.length === 0,
        diffs.slice(0, 12).join(" | ") + (diffs.length > 12 ? ` (+${diffs.length - 12})` : ""),
      );
      const expectedAmendments = Object.entries(TOKEN_AMENDMENTS[mode] || {})
        .flatMap(([k, props]) => Object.keys(props).map((p) => `${k}.${p}`))
        .sort();
      check(
        `${mode}: exactly the decided amendments applied, no more and no fewer`,
        JSON.stringify(amended.sort()) === JSON.stringify(expectedAmendments),
        `applied=${JSON.stringify(amended)} decided=${JSON.stringify(expectedAmendments)}`,
      );
    }

    // ─── 3. The code box survived losing the vendored stylesheet ────────────
    // SYMMETRY GATE FIRST, and it closes a real vacuity hole. The comparison
    // below iterates the GOLDEN's record and skips any part the golden lacks
    // (section 0 gates the records the golden DOES claim). So adding a probe to
    // the census without re-capturing compares nothing and reads as passing -
    // the exact disease this suite exists to prevent, and one that already bit
    // once when BOX_PROPS gained border/box-shadow. Asserted in both directions:
    // a part the golden has but the census dropped is lost coverage.
    for (const mode of ["light", "dark"]) {
      const gp = Object.keys(golden[mode].box).sort();
      const np = Object.keys(now[mode].box).sort();
      check(
        `${mode}: the golden records exactly the code-box parts the census probes`,
        JSON.stringify(gp) === JSON.stringify(np),
        `golden=${JSON.stringify(gp)} census=${JSON.stringify(np)}. Re-capture the golden from ${BASELINE_COMMIT}.`,
      );
    }
    for (const mode of ["light", "dark"]) {
      for (const part of [
        "pre",
        "preCode",
        "inlineCode",
        "inlineLangCode",
        "preNoLang",
        "preNoLangCode",
      ]) {
        const want = golden[mode].box[part];
        const got = now[mode].box[part];
        if (!want) continue; // reported by section 0
        // Section 0 gates the GOLDEN's records. This gates the LIVE one: if the
        // fixture stopped producing the element, `got` is null and every
        // property lookup below would throw rather than report, turning a real
        // coverage loss into a confusing harness crash.
        if (!got) {
          check(
            `${mode}: the fixture still renders the "${part}" element`,
            false,
            "the census selector matched nothing, so nothing was compared",
          );
          continue;
        }
        const diffs = [];
        const amended = [];
        for (const [p, v] of Object.entries(want)) {
          if (got[p] === v) continue;
          const am =
            BOX_AMENDMENTS[mode] &&
            BOX_AMENDMENTS[mode][part] &&
            BOX_AMENDMENTS[mode][part][p];
          if (am && am.was === v && am.now === got[p]) {
            amended.push(p);
            continue;
          }
          diffs.push(`${p}: golden=${v} now=${got[p]}`);
        }
        check(
          `${mode}: code box "${part}" reproduces the golden exactly`,
          diffs.length === 0,
          diffs.join(" | "),
        );
        const expected = Object.keys(
          (BOX_AMENDMENTS[mode] && BOX_AMENDMENTS[mode][part]) || {},
        ).sort();
        check(
          `${mode}: code box "${part}" applied exactly the decided amendments`,
          JSON.stringify(amended.sort()) === JSON.stringify(expected),
          `applied=${JSON.stringify(amended)} decided=${JSON.stringify(expected)}`,
        );
      }
    }

    // ─── 4. Reading surfaces are untouched ──────────────────────────────────
    // Nothing in this change was supposed to move prose, headings, tables or
    // blockquotes. Asserting it is how "I only touched syntax colours" stops
    // being a claim and becomes a measurement.
    for (const mode of ["light", "dark"]) {
      const diffs = [];
      for (const [sel, want] of Object.entries(golden[mode].surfaces)) {
        if (!want) continue; // reported by section 0
        const got = now[mode].surfaces[sel];
        if (!got) {
          diffs.push(`${sel}: no longer present`);
          continue;
        }
        for (const [p, v] of Object.entries(want)) {
          if (got[p] !== v) diffs.push(`${sel}.${p}: golden=${v} now=${got[p]}`);
        }
      }
      check(
        `${mode}: reading surfaces reproduce the golden exactly`,
        diffs.length === 0,
        diffs.slice(0, 10).join(" | "),
      );
    }

    // ─── 5. Code ::selection ────────────────────────────────────────────────
    // MEASURED END-TO-END, via getComputedStyle(el, '::selection'). An earlier
    // version of this block asserted two proxies instead, and both were
    // satisfiable by the wrong thing:
    //   - "resolves through a variable" tested the joined CSS TEXT of the
    //     matching rules against an unanchored /var\(\s*--code-selection-bg/,
    //     so a typo'd `--code-selection-bgg` matched the prefix and passed;
    //   - "is the amended value" read getComputedStyle(pre).getPropertyValue(
    //     '--code-selection-bg'), i.e. the VARIABLE DECLARATION, which cannot
    //     tell "the rule consumes it" from "the variable exists".
    // So breaking the consuming rule - a typo, or `background` changed to
    // `color` - left the suite green while code selection silently fell back to
    // the app-wide accent. The comment justifying that design claimed
    // getComputedStyle could not see ::selection; measured in Electron 43, it
    // can, and the golden now records it for both modes.
    for (const mode of ["light", "dark"]) {
      const want = golden[mode].selectionComputed;
      const got = now[mode].selectionComputed;
      const diffs = [];
      for (const part of ["pre", "preCode", "body"]) {
        const w =
          mode === "dark" && part !== "body" ? DARK_CODE_SELECTION.now : want[part];
        if (got[part] !== w) diffs.push(`${part}: expected=${w} now=${got[part]}`);
      }
      check(
        `${mode}: ::selection paints what the golden recorded`,
        diffs.length === 0,
        diffs.join(" | "),
      );
    }
    // The dark amendment's premise, asserted against the golden like every
    // other one: the old value must really have been the near-invisible navy.
    check(
      "the dark ::selection amendment still describes the golden",
      golden.dark.selectionComputed.pre === DARK_CODE_SELECTION.was,
      `amendment says was=${DARK_CODE_SELECTION.was}, golden says ${golden.dark.selectionComputed.pre}`,
    );
    // Cheap belt: a rule must still exist and must still route through the
    // variable, so a scheme can retint it. The computed check above is what
    // proves it actually paints.
    const selRules = now.light.selection.filter((r) =>
      /language-/.test(r.selector),
    );
    check(
      "code ::selection rules still exist and consume the variable",
      selRules.length > 0 &&
        selRules.some((r) => /var\(\s*--code-selection-bg\s*[,)]/.test(r.css)),
      selRules.map((r) => r.css).join(" ").slice(0, 200),
    );

    // ─── 6. The amendments' premises still hold ─────────────────────────────
    // An amendment excuses a difference. If what it claims to be excusing is no
    // longer what the golden says, the excuse is stale and must not stand.
    for (const [mode, byKey] of Object.entries(TOKEN_AMENDMENTS)) {
      for (const [key, props] of Object.entries(byKey)) {
        for (const [prop, am] of Object.entries(props)) {
          const goldenVal =
            golden[mode].tokens[key] && golden[mode].tokens[key][prop];
          check(
            `amendment ${mode}/${key}.${prop} still describes the golden`,
            goldenVal === am.was,
            `amendment says was=${am.was}, golden says ${goldenVal}`,
          );
        }
      }
    }

    // ─── 7. The vendored theme link is really gone ──────────────────────────
    // The whole point of inlining is that styles.css is the only source. A
    // leftover <link> would load AFTER it and win every specificity tie, so the
    // theme variables would appear to work and then be overruled in light mode.
    const linkCount = await exec(`
      [...document.querySelectorAll('link[rel=stylesheet]')]
        .filter(l => /prism.*themes/i.test(l.getAttribute('href') || '')).length`);
    check(
      "no PrismJS theme stylesheet is linked",
      linkCount === 0,
      `${linkCount} such <link> elements`,
    );

    // ─── 8. The indirection is declared where it actually works ─────────────
    // A custom property containing var() is substituted on the element where it
    // is DECLARED. Declared on :root (that is <html>), a body-level scheme
    // override of a coarse role would never reach the fine variable and every
    // scheme would silently render default syntax colours. Measured in Electron
    // 43; this asserts the arrangement rather than trusting the comment.
    //
    // ALL NINE ROLES, ALL TWENTY-FIVE CELLS, and the breadth is the point. An
    // earlier version overrode two roles and read ONE fine cell (--tok-builtin,
    // chosen because the two modes map it from different roles, so the resolved
    // value names WHICH block answered). That pinned the scope question but
    // covered one ninth of "the surface a new scheme fills in": baking both
    // --tok-comment cells to their resolved literals severs --syn-comment
    // outright - no scheme could ever restyle comments through the coarse role -
    // with zero appearance change and zero assertions firing. Proven by
    // mutation, not supposed.
    //
    // So every role gets its own sentinel and every cell is checked against what
    // its OWN authored declaration implies. A cell reading var(--syn-X) must
    // resolve to X's sentinel; a cell holding a literal must be unmoved. The
    // authored side is read from the CSSOM rather than hard-coded here, so this
    // cannot drift out of step with the stylesheet - what it pins is that the
    // declaration is EFFECTIVE at body scope, while the golden pins that it
    // names the right role.
    //
    // A custom property's value is preserved as the author's literal token
    // stream - it is NOT re-serialised as a colour - so values are compared with
    // whitespace stripped rather than in getComputedStyle's "rgb(1, 2, 3)" form.
    const SYN_ROLES = [
      "comment",
      "punctuation",
      "operator",
      "keyword",
      "string",
      "literal",
      "tag",
      "function",
      "variable",
      // A BACKGROUND swatch rather than a foreground colour, and the reason it
      // is a role at all: see ROLE_FREE_CELLS below. The sentinel machinery
      // does not care - it substitutes an unmistakable literal and asks which
      // cells received it, which works the same for a background.
      "entity-bg",
    ];
    // Distinct, and distinguishable from any real palette value.
    const SENTINEL = {};
    SYN_ROLES.forEach((r, i) => {
      SENTINEL[`--syn-${r}`] = `rgb(${i + 1},0,0)`;
    });
    // PARKED BEFORE THE PROBE RUNS so that the probe's own park/restore is
    // FALSIFIABLE. The probe swaps body's data-theme for its own value and must
    // put back whatever it found; an earlier version deleted it unconditionally.
    // Nothing in the app sets data-theme yet, so that bug was inert - and a fix
    // whose absence changes nothing cannot be proven, it can only be asserted
    // by its author. This sentinel matches no rule (there are no scheme blocks
    // yet), so it cannot disturb a single measurement, but it must survive.
    await exec(`document.body.setAttribute('data-theme', '__parked__')`);
    const scopeProbe = JSON.parse(
      await exec(`(() => {
        const SENT = ${JSON.stringify(SENTINEL)};
        const decls = Object.entries(SENT)
          .map((kv) => kv[0] + ':' + kv[1])
          .join(';');
        const s = document.createElement('style');
        s.textContent = 'body[data-theme="__probe__"]{' + decls + '}';
        document.head.appendChild(s);
        const had = document.body.classList.contains('dark-mode');
        // BOTH pieces of state this probe disturbs must be PARKED, not assumed.
        // An earlier version saved the dark-mode class but removed data-theme
        // unconditionally, which is inert only while nothing sets it. That
        // attribute is exactly what the scheme blocks and the PDF-export
        // park/restore will use, so the moment a scheme is active this probe
        // would strip it and every later section would measure the DEFAULT
        // scheme under a name claiming otherwise - passing, and wrong.
        const hadTheme = document.body.getAttribute('data-theme');
        document.body.setAttribute('data-theme', '__probe__');
        const authoredIn = (selector) => {
          // EVERY --tok-* declaration in the document, with the selector that
          // made it. Deliberately NOT filtered to the block selector up front:
          // the failure this section exists to catch MOVES a declaration to
          // :root, and a probe that only looks at the body-level rule would
          // find the cell simply MISSING rather than wrong - it would drop out
          // of the list and stop being checked at all. That is how the
          // behavioural assertion below went unfalsifiable once, caught by R259
          // coming back WRONG-GUARD. The cell list is therefore
          // scope-independent and the scope is asserted separately.
          const seen = {};
          const at = {};
          const take = (rule, sel) => {
            for (const prop of rule.style) {
              if (prop.indexOf('--tok-') !== 0) continue;
              seen[prop] = rule.style.getPropertyValue(prop).trim();
              at[prop] = sel;
            }
          };
          const inherited = [];
          const matching = [];
          for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch (e) { continue; }
            for (const rule of rules || []) {
              if (!rule.style || !rule.selectorText) continue;
              let hits = false;
              try { hits = document.body.matches(rule.selectorText); } catch (e) { hits = false; }
              if (hits) matching.push(rule);
              // :root / html do not match <body>, but they still reach it by
              // inheritance - outbid by any rule that does match.
              else if (/^\s*(:root|html)\s*$/.test(rule.selectorText)) inherited.push(rule);
            }
          }
          inherited.forEach((r) => take(r, r.selectorText));
          matching.forEach((r) => take(r, r.selectorText));
          return { authored: seen, declaredAt: at, block: selector };
        };
        const readAll = (names) => {
          const cs = getComputedStyle(document.body);
          const out = {};
          for (const n of names) out[n] = cs.getPropertyValue(n).replace(/\\s+/g, '');
          return out;
        };
        const shot = (selector, dark) => {
          document.body.classList.toggle('dark-mode', dark);
          const a = authoredIn(selector);
          return {
            authored: a.authored,
            declaredAt: a.declaredAt,
            block: a.block,
            computed: readAll(Object.keys(a.authored)),
          };
        };
        const light = shot('body', false);
        const dark = shot('body.dark-mode', true);
        document.body.classList.toggle('dark-mode', had);
        if (hadTheme === null) document.body.removeAttribute('data-theme');
        else document.body.setAttribute('data-theme', hadTheme);
        s.remove();
        return JSON.stringify({ light, dark });
      })()`),
    );
    {
      const parked = JSON.parse(
        await exec(`(() => {
          const v = document.body.getAttribute('data-theme');
          document.body.removeAttribute('data-theme');
          return JSON.stringify(v);
        })()`),
      );
      check(
        "the scope probe restores the data-theme it found instead of deleting it",
        parked === "__parked__",
        `data-theme came back as ${JSON.stringify(parked)} - the probe parks body's dark-mode class but must park this attribute too; once scheme blocks land, deleting it would silently drop every later section back to the DEFAULT scheme while still reporting the scheme's name`,
      );
    }
    for (const mode of ["light", "dark"]) {
      const { authored, computed, declaredAt, block } = scopeProbe[mode];
      const cells = Object.keys(authored);
      check(
        `${mode}: the probe found every fine cell the stylesheet declares`,
        cells.length === 25,
        `read ${cells.length} --tok-* declarations, expected 25 (see the THEME TOKENS header)`,
      );
      // THE SCOPE ASSERTION, and it is separate from the behavioural one on
      // purpose: this one names the CAUSE ("declared at :root") while the one
      // below reports the CONSEQUENCE (the override does not land). Between
      // them a single misplaced cell fails loudly and legibly instead of
      // quietly dropping out of the checked set.
      const misplaced = cells
        .filter((c) => declaredAt[c] !== block)
        .map((c) => `${c} is declared at "${declaredAt[c]}"`);
      check(
        `${mode}: every fine cell is declared at body scope, not :root`,
        misplaced.length === 0,
        `${misplaced.join(" | ")} - expected "${block}". A var() in a custom property is substituted on the element that DECLARES it, so a scheme override on <body> can never reach a cell declared on <html>.`,
      );
      const wrong = [];
      const rolesSeen = new Set();
      for (const cell of cells) {
        const m = authored[cell].match(/^var\((--syn-[a-z-]+)\)$/);
        let want;
        if (m) {
          rolesSeen.add(m[1]);
          want = (SENTINEL[m[1]] || "").replace(/\s+/g, "");
          if (!want) {
            wrong.push(`${cell}: names unknown role ${m[1]}`);
            continue;
          }
        } else if (authored[cell] === "inherit") {
          // `inherit` on a custom property takes html's value, and html declares
          // none, so it computes to the empty string. The consuming var() then
          // has no substitution and the property falls back to unset, which for
          // an inherited property is inherit - which is the intent. Section 9
          // pins these cells' painted result.
          want = "";
        } else {
          want = authored[cell].replace(/\s+/g, "");
        }
        if (computed[cell] !== want) {
          wrong.push(
            `${cell}: authored "${authored[cell]}" should resolve to "${want}" but read "${computed[cell]}"`,
          );
        }
      }
      check(
        `${mode}: a body-level role override reaches every fine cell it names`,
        wrong.length === 0,
        `${wrong.join(" | ")}. A ":root" declaration yields the ORIGINAL palette value instead of the sentinel.`,
      );
      const missingRoles = SYN_ROLES.map((r) => `--syn-${r}`).filter(
        (r) => !rolesSeen.has(r),
      );
      check(
        `${mode}: every coarse role is still reached by at least one fine cell`,
        missingRoles.length === 0,
        `${missingRoles.join(", ")} is declared but nothing consumes it, so a scheme could never restyle it`,
      );
      // THE OTHER DIRECTION, and it was missing. The assertion above walks
      // roles->cells, so a cell that names NO role is invisible to it: it
      // simply never joins rolesSeen. That is the shape of a real trap for
      // part 2 - a scheme fills every advertised role, and the cells that read
      // from none of them keep the DEFAULT scheme's literal. Entities on
      // Solarized cream is not a hypothetical; it is amendment 1 in the dark
      // block, which exists because precisely that leaked once already.
      //
      // So role-free cells are not banned - some are legitimate - but the set
      // is CLOSED and named. `inherit` records that the source theme wrote no
      // rule, which is a structural fact rather than a colour a scheme could
      // supply; --tok-namespace-opacity is not a palette entry. The two dark
      // literals ARE colours, kept deliberately because mapping them onto an
      // existing role would repaint them and the golden forbids that - so they
      // are listed as cells a scheme author must set by hand.
      //
      // Listed per mode, because the light and dark blocks genuinely differ
      // here: light's --tok-inserted DOES name a role and dark's does not.
      const ROLE_FREE_CELLS = {
        light: [
          "--tok-block-comment",
          "--tok-function-name",
          "--tok-namespace",
          "--tok-namespace-opacity",
          "--tok-operator",
        ],
        dark: [
          "--tok-function-name",
          "--tok-inserted",
          "--tok-namespace-opacity",
        ],
      };
      const roleFree = cells
        .filter((c) => !/^var\(--syn-[a-z-]+\)$/.test(authored[c]))
        .sort();
      check(
        `${mode}: exactly the listed fine cells read from no coarse role`,
        JSON.stringify(roleFree) === JSON.stringify(ROLE_FREE_CELLS[mode]),
        `found=${JSON.stringify(roleFree)} listed=${JSON.stringify(ROLE_FREE_CELLS[mode])} - a cell that names no role keeps this scheme's literal under EVERY future scheme, so adding one is a decision that has to be recorded here`,
      );
    }

    // THE COMMENT'S NUMBER, MEASURED. src/styles.css claims in two places that
    // a specific number of the 25 fine cells map from a DIFFERENT coarse role
    // in dark than in light, and that claim is the entire justification for
    // declaring the mapping twice instead of once. It went stale the moment
    // --tok-entity-bg was promoted to a role: both blocks then read
    // var(--syn-entity-bg), the count fell from 16 to 15, and nothing noticed -
    // not this suite, not --anchors, not --expects, none of which can see a
    // stale number in prose. That is the same comment-rot that a revert's
    // rationale hit one round earlier. A number a reader is invited to trust
    // has to be measured or deleted, so this measures it.
    {
      const L = scopeProbe.light.authored;
      const D = scopeProbe.dark.authored;
      const differing = Object.keys(L)
        .filter((c) => L[c] !== D[c])
        .sort();
      check(
        "the per-mode mapping differs in exactly the number of cells the stylesheet claims",
        differing.length === 15,
        `${differing.length} cells differ (${differing.join(", ")}) but src/styles.css says 15, in the THEME TOKENS header and again above the dark mapping. If the mapping really changed, both comments and this number move together.`,
      );
    }

    // ─── 9. Rules no bundled grammar can reach ──────────────────────────────
    // `deleted` and `inserted` are emitted by NO bundled grammar (there is no
    // diff component, and the CSP is script-src 'self', so the bundled
    // autoloader cannot fetch one either). `block-comment` likewise appears in
    // no grammar, and neither does `bold` or `italic`. `function-name` is
    // emitted only by bash, and always with alias:function, so `.token.function`
    // - declared later - always wins on the real element. Measured, not assumed:
    // grepping the 16 files in libs/prismjs/components for each of these names
    // finds only bash's function-name. All six therefore render nowhere in the
    // fixture and the golden CANNOT cover them: their declarations could be
    // changed to anything at all and every assertion above would stay green.
    //
    // They are still shipped rules, so they are measured directly by injecting
    // an element carrying the class into a real highlighted code block and
    // asking what it comes out as. That is an end-to-end check of the rule, not
    // a re-reading of the variable: it fails if the selector is dropped, if the
    // declaration stops consuming the variable, or if the rule is shadowed.
    //
    // Each case names the PROPERTY it is about, because two of these rules are
    // not about colour at all.
    //
    // THE EXPECTED VALUES ARE PINNED TO THE SHIPPED SOURCE, NOT DERIVED FROM THE
    // VARIABLE THE RULE CONSUMES. An earlier version read --tok-deleted and
    // asked whether the element painted that - which proves the rule is WIRED
    // but says nothing about whether it is wired to the RIGHT value, because
    // both sides of the comparison move together when the cell is edited. These
    // cells render nowhere, so the golden cannot supply the value either; it is
    // therefore taken from the two files that WERE the defaults, read out of the
    // pre-refactor tree:
    //
    //   light  git show 4bbde83:libs/prismjs/themes/prism-solarizedlight.css
    //          - the only PrismJS theme index.html ever linked
    //   dark   git show 4bbde83:src/styles.css, the body.dark-mode override
    //          block (prism-tomorrow.css was vendored but NEVER LINKED, so it
    //          was not the dark source despite carrying the same values)
    //
    // INHERIT means that file declares no rule for the class at all, so the
    // element took its enclosing colour. That is UNFALSIFIABLE by painting -
    // "no rule" and "color: inherit" are indistinguishable on the element - so
    // for those cells the DECLARATION is pinned separately below, and the
    // linkage is proven by the other mode, where the value is absolute.
    const REACHLESS = {
      deleted: { prop: "color", from: "--tok-deleted", light: "#268bd2", dark: "#e2777a" },
      inserted: { prop: "color", from: "--tok-inserted", light: "#2aa198", dark: "#8fa876" },
      "function-name": { prop: "color", from: "--tok-function-name", light: "INHERIT", dark: "#6196cc" },
      "block-comment": { prop: "color", from: "--tok-block-comment", light: "INHERIT", dark: "#999" },
      // Emitted by no bundled grammar either: `symbol` appears in the shipped
      // components only INSIDE TypeScript's `builtin` pattern, never as a token
      // name of its own. It was missing from this ledger and from the golden
      // both, which is the gap the closure assertion below now closes.
      symbol: { prop: "color", from: "--tok-constant", light: "#268bd2", dark: "#f8c555" },
      // No variable behind these two - the rule declares a literal - so the
      // literal itself is the ground truth. Deleting the selector or the
      // declaration drops the element back to the inherited value and fails.
      bold: { prop: "fontWeight", light: "bold", dark: "bold" },
      italic: { prop: "fontStyle", light: "italic", dark: "italic" },
    };
    // THE LEDGER IS NOW CLOSED, and until it was, it was a hand-written list
    // with nothing checking it against the CSS. The coverage argument this
    // whole suite rests on is "every styled token class is either measured by
    // the golden or pinned here". Nothing asserted it, so four classes fell
    // through both halves at once: `symbol` (styled, unreachable, unlisted) and
    // `char`/`prolog`/`cdata` (styled, REACHABLE, but absent from the fixture
    // so absent from the golden). Consequence: any of those four could be
    // deleted from its selector list and all assertions stayed green - the
    // exact selector-deletion failure R271/R275/R278 exist to catch.
    //
    // The styled set is read from document.styleSheets rather than by parsing
    // the file, so it is the CSS the app actually parsed, and it descends into
    // grouping rules so a class styled only inside @media still counts.
    const classGaps = JSON.parse(
      await exec(`(() => {
        const styled = new Set();
        const walk = (list) => {
          for (const r of list) {
            if (r.cssRules) walk(r.cssRules);
            if (!r.selectorText) continue;
            const re = /\\.token((?:\\.[a-zA-Z][a-zA-Z0-9-]*)+)/g;
            let m;
            while ((m = re.exec(r.selectorText))) {
              m[1].split('.').filter(Boolean).forEach((c) => styled.add(c));
            }
          }
        };
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch (e) { continue; }
          if (rules) walk(rules);
        }
        return JSON.stringify([...styled].sort());
      })()`),
    );
    const styledClasses = new Set(classGaps);
    const ledgerNotStyled = Object.keys(REACHLESS).filter(
      (c) => !styledClasses.has(c),
    );
    // THE VACUITY GUARD for the closure assertion below, and it is not
    // ceremonial: if the selector scrape broke, `styled` would be empty, the
    // closure would have nothing to complain about and would pass. This fails
    // first and says why.
    check(
      "every class in the unreachable ledger is really styled by the shipped CSS",
      ledgerNotStyled.length === 0 && styledClasses.size > 0,
      `${ledgerNotStyled.join(", ") || "(scrape found no styled token class at all)"} - the ledger pins a value for a class the stylesheet no longer styles, or the selector scrape stopped working`,
    );
    const goldenClasses = new Set();
    for (const key of Object.keys(golden.light.tokens)) {
      for (const part of key.split("@").join(">").split(">")) {
        for (const c of part.split(".")) if (c) goldenClasses.add(c);
      }
    }
    const unmeasured = [...styledClasses].filter(
      (c) => !goldenClasses.has(c) && !(c in REACHLESS),
    );
    check(
      "every styled token class is either measured by the golden or listed as unreachable",
      unmeasured.length === 0,
      `${unmeasured.join(", ")} - styled by src/styles.css, rendered nowhere in the fixture and absent from REACHLESS, so its declaration could be deleted with every assertion staying green. Either add a snippet that emits it and re-capture the golden, or pin it here`,
    );
    for (const mode of ["light", "dark"]) {
      await exec(
        `document.body.classList.toggle('dark-mode', ${mode === "dark"})`,
      );
      const got = JSON.parse(
        await exec(`(() => {
          const CASES = ${JSON.stringify(REACHLESS)};
          const MODE = ${JSON.stringify(mode)};
          const BLOCK = MODE === 'dark' ? 'body.dark-mode' : 'body';
          // The AUTHORED declaration, read from the CSSOM rather than from
          // getComputedStyle. That is not a stylistic preference: a custom
          // property declared "inherit" on <body> takes html's value, and html
          // declares none, so the computed value is the EMPTY STRING - the
          // consuming var() then has no substitution and "color" falls back to
          // unset, which for an inherited property is inherit. The painted
          // result is right; the computed property is simply not where the
          // decision is recorded.
          // WHERE the declaration lives is section 8's business, not this
          // section's - here the question is only what VALUE the shipped
          // default declares. So an inherited :root/html declaration is
          // accepted as a fallback when the body-level block has none; that
          // keeps a misplaced block reported once, by the assertion named for
          // it, instead of also failing here under a misleading name.
          const declaredIn = (prop) => {
            let found = null;
            let fallback = null;
            for (const sheet of document.styleSheets) {
              let rules;
              try { rules = sheet.cssRules; } catch (e) { continue; }
              if (!rules) continue;
              for (const rule of rules) {
                if (!rule.style || !rule.selectorText) continue;
                const v = rule.style.getPropertyValue(prop).trim();
                if (!v) continue;
                if (rule.selectorText === BLOCK) found = v;
                else if (/^\s*(:root|html)\s*$/.test(rule.selectorText)) fallback = v;
              }
            }
            return found !== null ? found : fallback;
          };
          const code = document.querySelector('#viewer pre[class*=language-] code');
          const host = document.createElement('span');
          code.appendChild(host);
          const probe = document.createElement('span');
          host.appendChild(probe);
          // Canonicalises whatever the source held (#rrggbb, a keyword) into the
          // same serialisation getComputedStyle returns, so the comparison is
          // never decided by spelling.
          const canonical = (prop, v) => {
            probe.style[prop] = '';
            probe.style[prop] = v;
            return getComputedStyle(probe)[prop];
          };
          const out = {};
          for (const [cls, spec] of Object.entries(CASES)) {
            const el = document.createElement('span');
            el.className = 'token ' + cls;
            el.textContent = 'x';
            host.appendChild(el);
            const truth = spec[MODE];
            out[cls] = {
              prop: spec.prop,
              truth: truth,
              actual: getComputedStyle(el)[spec.prop],
              expected: truth === 'INHERIT'
                ? getComputedStyle(host)[spec.prop]
                : canonical(spec.prop, truth),
              // Read only for the INHERIT cells, where painting cannot tell a
              // missing rule from an inherited one.
              declared: spec.from ? declaredIn(spec.from) : null,
            };
            el.remove();
          }
          host.remove();
          return JSON.stringify(out);
        })()`),
      );
      // A case that silently disappeared from the payload would otherwise be
      // reported as zero differences, which is the vacuity this section exists
      // to prevent - so the payload is checked for completeness first.
      const missing = Object.keys(REACHLESS).filter((k) => !got[k]);
      check(
        `${mode}: every unreachable-class probe reported a result`,
        missing.length === 0,
        `no result for: ${missing.join(", ")}`,
      );
      const bad = Object.entries(got)
        .filter(([, v]) => v.actual !== v.expected)
        .map(
          ([k, v]) =>
            `${k}.${v.prop}: source=${v.truth} expected=${v.expected} actual=${v.actual}`,
        );
      check(
        `${mode}: rules for token classes no grammar emits paint the shipped default's value`,
        bad.length === 0,
        bad.join(" | "),
      );

      // The value assertion above is structurally blind for a cell whose ground
      // truth is INHERIT: dropping the rule leaves the element inheriting too,
      // so both readings agree. What can still be pinned is that the cell says
      // `inherit` rather than an invented absolute - which is exactly the
      // regression Opus found in the light operator/namespace cells.
      // Two-sided: without this, dark - which has no INHERIT cells - compares an
      // empty list against an empty list and cannot fail, and light would do the
      // same the moment a payload key went missing.
      const inheritCells = Object.entries(got)
        .filter(([, v]) => v.truth === "INHERIT")
        .map(([k]) => k);
      const wantInherit = Object.entries(REACHLESS)
        .filter(([, s]) => s[mode] === "INHERIT")
        .map(([k]) => k);
      check(
        `${mode}: the inherit-cell set is exactly the one the shipped default has`,
        inheritCells.join(",") === wantInherit.join(","),
        `probe reported [${inheritCells.join(", ")}], source says [${wantInherit.join(", ")}]`,
      );
      const wrongDecl = Object.entries(got)
        .filter(([, v]) => v.truth === "INHERIT" && v.declared !== "inherit")
        .map(([k, v]) => `${k}: --tok-* declares "${v.declared}", must be "inherit"`);
      check(
        `${mode}: cells whose default declares no rule are pinned to inherit`,
        wrongDecl.length === 0,
        wrongDecl.join(" | "),
      );
    }

    // ─── SECTION 10: THE SCHEME LAYER ───────────────────────────────────────
    // Sections 1-9 guard FIDELITY: the two default schemes must look exactly as
    // Folia looked before the theme system existed. This section guards the
    // thing built on top - the four additional schemes, the registry that names
    // them and the menu that applies them.
    //
    // IT EXISTS BECAUSE A SCREENSHOT FOUND WHAT EVERY NUMBER MISSED. Abyss
    // shipped visibly half-themed - the Open File button and the active
    // carousel dot stayed default teal on a blue page - while every WCAG ratio
    // in the suite was green. Contrast is a relationship between a foreground
    // and THE BACKGROUND IT WAS MEASURED AGAINST; it cannot notice that the
    // background belongs to a different palette. So a contrast bar alone can
    // never catch a stranded surface, and 10c below is the assertion that can.
    const HELD = "window.__foliaExportThemeHeld";

    /* Properties a scheme is NOT required to override, each with the reason.
       Anything else the mode's base declares as a LITERAL must be overridden,
       and the required list is DERIVED from the base blocks rather than
       restated here - so adding a new chrome variable without adding it to the
       four schemes fails, naming the variable. That is exactly the accident
       that stranded the Open File button. */
    const SCHEME_EXCUSALS = {
      "--toc-width":
        "a layout dimension (300px), not a palette value - the table of contents is the same width in every scheme",
      "--tok-namespace-opacity":
        "a per-MODE legibility dimming (.7 light / 1 dark), inherited from the mode base on purpose: it is a decision about the page's contrast, not about the palette, and every scheme of a mode wants its mode's answer",
    };

    // ── 10a: the registry and the stylesheet must agree, in BOTH directions ──
    // Either half alone permits a dead entry: a registered scheme with no CSS
    // block applies data-theme and paints nothing, and a CSS block no scheme
    // names is unreachable styling nobody can select.
    const reg = JSON.parse(
      await exec(`(() => {
        const cssIds = new Set();
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          if (!rules) continue;
          for (const rule of rules) {
            if (!rule.selectorText) continue;
            const m = /^body\\[data-theme="([^"]+)"\\]$/.exec(rule.selectorText.trim());
            if (m) cssIds.add(m[1]);
          }
        }
        const S = window.foliaThemes.SCHEMES;
        return JSON.stringify({
          cssIds: [...cssIds],
          nonBase: S.filter((s) => !s.base).map((s) => s.id),
          byMode: { light: S.filter((s) => s.mode === 'light').length,
                    dark: S.filter((s) => s.mode === 'dark').length },
          bases: S.filter((s) => s.base).map((s) => s.mode),
        });
      })()`),
    );
    const missingBlocks = reg.nonBase.filter((id) => !reg.cssIds.includes(id));
    const orphanBlocks = reg.cssIds.filter((id) => !reg.nonBase.includes(id));
    check(
      "every registered non-base scheme has a body[data-theme] block in the stylesheet",
      missingBlocks.length === 0,
      `registered with no CSS: ${missingBlocks.join(", ")}`,
    );
    check(
      "every body[data-theme] block in the stylesheet is a registered scheme",
      orphanBlocks.length === 0,
      `CSS blocks nothing can select: ${orphanBlocks.join(", ")}`,
    );
    // Vacuity floor. Both directions above are satisfied by an EMPTY registry
    // against an EMPTY stylesheet, which is the state this whole section is
    // meant to guard against reaching by accident.
    check(
      "the registry ships schemes in both modes, plus exactly one base per mode",
      reg.nonBase.length >= 4 &&
        reg.byMode.light >= 2 &&
        reg.byMode.dark >= 2 &&
        reg.bases.sort().join(",") === "dark,light",
      `nonBase=${reg.nonBase.length} light=${reg.byMode.light} dark=${reg.byMode.dark} bases=[${reg.bases.join(", ")}]`,
    );

    // ── 10b: completeness - a scheme must not inherit half its palette ───────
    // The base for a LIGHT scheme is :root + body; for a DARK scheme it is
    // :root + body + body.dark-mode, because dark overrides only what differs.
    // A var()-derived cell is exempt BY CONSTRUCTION: it resolves through a
    // coarse --syn-* role the scheme does override, so it retints on its own.
    // Only LITERALS can strand.
    const cover = JSON.parse(
      await exec(`(() => {
        const decl = (selector) => {
          const set = new Map();
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
            if (!rules) continue;
            for (const rule of rules) {
              if (!rule.style || rule.selectorText !== selector) continue;
              for (const p of rule.style) {
                if (p.startsWith('--')) set.set(p, rule.style.getPropertyValue(p).trim());
              }
            }
          }
          return set;
        };
        const merge = (...maps) => {
          const m = new Map();
          for (const x of maps) for (const [k, v] of x) m.set(k, v);
          return m;
        };
        const root = decl(':root'), body = decl('body'), dark = decl('body.dark-mode');
        const bases = { light: merge(root, body), dark: merge(root, body, dark) };
        /* REQUIRED, not DECLARED. The completeness check below only ever
           requires the LITERAL-valued subset of the base - a var()-derived cell
           follows its source by construction - so flooring the total would let
           the required list collapse without the floor moving at all: convert
           30 base literals to var() references and 10b silently stops requiring
           30 variables while every assertion stays green. */
        const literalCount = (m) =>
          [...m.entries()].filter(([, v]) => !v.includes('var(')).length;
        const out = {
          baseSize: { light: bases.light.size, dark: bases.dark.size },
          requiredSize: { light: literalCount(bases.light), dark: literalCount(bases.dark) },
          requiredNames: {
            light: [...bases.light.entries()].map(([k, v]) => [k, v]),
            dark: [...bases.dark.entries()].map(([k, v]) => [k, v]),
          },
          schemes: {},
        };
        for (const s of window.foliaThemes.SCHEMES.filter((x) => !x.base)) {
          const own = decl('body[data-theme="' + s.id + '"]');
          const base = bases[s.mode];
          out.schemes[s.id] = {
            mode: s.mode,
            own: own.size,
            literalMissing: [...base.entries()]
              .filter(([k, v]) => !own.has(k) && !v.includes('var('))
              .map(([k]) => k),
          };
        }
        return JSON.stringify(out);
      })()`),
    );
    check(
      "the derived required-variable list is substantial (the completeness check is not vacuous)",
      cover.requiredSize.light >= 50 && cover.requiredSize.dark >= 50,
      `light base declares ${cover.baseSize.light} variables of which ${cover.requiredSize.light} are literal-valued and therefore REQUIRED of a scheme; dark ${cover.baseSize.dark}/${cover.requiredSize.dark} - it is the required count that makes the completeness check non-vacuous, not the declared one`,
    );
    const excusedNames = Object.keys(SCHEME_EXCUSALS);
    const excusalUsed = new Set();
    for (const [id, v] of Object.entries(cover.schemes)) {
      const stranded = v.literalMissing.filter((k) => {
        if (excusedNames.includes(k)) {
          excusalUsed.add(k);
          return false;
        }
        return true;
      });
      check(
        `${id}: overrides every literal its mode's base declares`,
        stranded.length === 0,
        `frozen to the ${v.mode} default palette: ${stranded.join(", ")}`,
      );
    }
    // A stale excusal is a hole nobody can see. If a variable stops being
    // skipped - because it was deleted, or because the schemes started
    // declaring it - the entry must go, or it silently widens the exemption for
    // whatever is added under that name next.
    const staleExcusals = excusedNames.filter((k) => !excusalUsed.has(k));
    check(
      "every scheme excusal is still load-bearing",
      staleExcusals.length === 0,
      `no scheme skips these any more, so the entries must be removed: ${staleExcusals.join(", ")}`,
    );

    // ── 10c: no default-accent literal may survive under a scheme ────────────
    // THE ABYSS FINDING AS A TIER-1 ASSERTION. Walks every element over every
    // colour-valued property looking for a colour from the DEFAULT accent
    // family while a non-base scheme is applied. An element still painting one
    // is a surface the scheme cannot reach.
    const ACCENT_PROBE = `(() => {
      /* SUBSTRING NEEDLES, NOT EXACT KEYS, and the reason is box-shadow: it
         serialises as 'rgba(39, 158, 167, 0.35) 0px 3px 12px', so an exact
         lookup can never match it however many properties are scanned.
         The ALPHA forms are listed separately because every accent glow and
         tint in the base stylesheet uses the accent with an alpha - 18 of
         them - and each was invisible to an opaque-only list.
         The hover family was WRONG here: this list carried 'rgb(42, 143, 150)'
         (#2a8f96), a colour that appears NOWHERE in src (verified by search),
         while the three hover accents the product actually ships - #1f8089,
         #1f8a92 and #4FCDD6 - were absent. A dead needle is not merely
         useless: it reads as coverage. */
      const NEEDLES = [
        ['rgb(39, 158, 167)', '#279EA7 default accent (light)'],
        ['rgba(39, 158, 167', '#279EA7 default accent with alpha (light)'],
        ['rgb(61, 189, 198)', '#3DBDC6 default accent (dark)'],
        ['rgba(61, 189, 198', '#3DBDC6 default accent with alpha (dark)'],
        ['rgb(59, 191, 204)', '#3bbfcc default welcome accent (dark)'],
        ['rgba(59, 191, 204', '#3bbfcc default welcome accent with alpha (dark)'],
        ['rgb(31, 128, 137)', '#1f8089 default accent hover (light)'],
        ['rgb(31, 138, 146)', '#1f8a92 default welcome solid hover (light)'],
        ['rgb(79, 205, 214)', '#4FCDD6 default accent hover (dark)'],
        ['rgb(31, 50, 68)',   '#1F3244 default ink/panel/table header (light)'],
      ];
      const PROPS = ['color','backgroundColor','backgroundImage','borderTopColor','borderRightColor',
                     'borderBottomColor','borderLeftColor','fill','stroke',
                     'outlineColor','textDecorationColor','caretColor','boxShadow'];
      const seen = new Set();
      const hits = [];
      const needleHits = {};
      for (const n of NEEDLES) needleHits[n[0]] = 0;
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const cs = getComputedStyle(el);
        for (const p of PROPS) {
          const val = cs[p];
          if (!val || typeof val !== 'string') continue;
          /* EVERY matching needle is counted, and the count is taken BEFORE
             the per-cell dedup below. The dedup exists to keep the failure
             message readable; letting it also decide needle coverage would
             mean a needle whose only paint happens to share a cell with an
             earlier needle reads as dead. */
          const matched = NEEDLES.filter((n) => val.indexOf(n[0]) !== -1);
          for (const n of matched) needleHits[n[0]]++;
          if (!matched.length) continue;
          const found = matched[0];
          const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\\s+/)[0] : '');
          const k = sel + '|' + p;
          if (seen.has(k)) continue;
          seen.add(k);
          hits.push(sel + ' { ' + p + ': ' + val + ' }  <- ' + found[1]);
        }
      }
      return JSON.stringify({ scanned: all.length, hits: hits, needles: needleHits });
    })()`;

    /* Drives the PRODUCT's own entry point rather than a copy of it, so the
       stored-preference bookkeeping, applyTheme(), the #darkModeToggle click
       and markActive() all run.
       THE BASE STATES GO THROUGH setScheme() TOO, and that is the whole point
       of this shape. The earlier version hand-rolled the default branch -
       remove the two scheme keys, call applyScheme(mode), toggle the class -
       which is a REIMPLEMENTATION of the product's base path, not a use of it.
       Every baseline in 10c, 10d and 10f is measured through here, so a defect
       in the real base path (markActive never running, the toggle's mermaid
       side effects never firing, a base id failing to clear data-theme) would
       have been invisible to the entire section while the suite reported the
       defaults intact. The base ids are registry entries like any other. */
    const applyState = (mode, scheme) =>
      exec(`(() => {
        localStorage.setItem('themeMode', ${JSON.stringify(mode)});
        window.foliaThemes.setScheme(${JSON.stringify(scheme || `default-${mode}`)});
        return (document.body.getAttribute('data-theme') || 'none') + '/' +
               (document.body.classList.contains('dark-mode') ? 'dark' : 'light');
      })()`);

    /* A COLOUR READ WHILE A TRANSITION IS RUNNING IS THE PREVIOUS SCHEME'S
       COLOUR, and it reads exactly like a stranded surface.
       custom-styles.css puts `transition: background .2s` on the update and
       file-update buttons, so sampling straight after a scheme change reported
       three buttons still painting the DEFAULT DARK accent while the very same
       elements resolved --primary-color to the new scheme's blue. Only one CSS
       rule matched them and it read var(--primary-color): the computed value
       was mid-flight, not wrong.

       So this waits on the engine's own animation registry rather than
       sleeping a guessed number of milliseconds - the browser knows when a
       transition has finished and nothing else does. Restricted to
       CSSTransition on purpose: a looping CSSAnimation (a spinner) is always
       "running" and would turn every settle into a silent timeout. */
    const settleTransitions = () =>
      exec(`(() => {
        const running = document.getAnimations().filter(
          (a) => typeof CSSTransition !== 'undefined' && a instanceof CSSTransition
        );
        return running.length;
      })()`);
    let settleFailures = [];
    let maxRunning = 0;
    const applySettled = async (mode, scheme, label) => {
      const applied = await applyState(mode, scheme);
      let running = -1;
      for (let i = 0; i < 60; i++) {
        running = await settleTransitions();
        maxRunning = Math.max(maxRunning, running);
        if (running === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (running !== 0) settleFailures.push(`${label}: ${running} still running`);
      return applied;
    };

    const SCHEME_STATES = [
      ["light", "clarity"],
      ["light", "parchment"],
      ["dark", "abyss"],
      ["dark", "ember"],
    ];

    /* 10b, SECOND HALF: a cell must RESOLVE, not merely be DECLARED.
       The completeness check above reads the CSSOM, so it answers "does this
       scheme have a declaration for --header-bg" - and `--header-bg:
       var(--typo)` answers YES. A custom property whose value references a
       variable that does not exist computes to the guaranteed-invalid value
       and reads back as the EMPTY STRING, so every consumer of it falls back
       to its own default or paints nothing, while 10b reports full coverage.
       Nothing else in the suite sees it either: 10c only hunts for the DEFAULT
       accent (an unresolved cell paints neither the default nor the scheme
       colour), and 10d skips fully transparent surfaces.

       AN EMPTY COMPUTED VALUE IS NOT ALWAYS A DEFECT, and the distinction is
       measured rather than excused. Light authors four cells as the CSS-wide
       keyword `inherit` - --tok-block-comment, --tok-operator, --tok-namespace
       and --tok-function-name - because Solarized Light declares no rule for
       any of them and the token really must take its parent's colour. That
       computes to the empty string BY DESIGN, and the consumer's
       `color: var(--tok-operator)` becoming invalid-at-computed-value-time is
       precisely the mechanism that produces the inheritance. Those four are
       covered on the appearance axis by the frozen golden, which recorded the
       real painted colour per context chain (operator@class-name yellow vs
       operator@ base00 - the very difference an invented absolute erased).
       So the classifier is the authored value, not a name list: a CSS-wide
       keyword is intended, anything else computing to empty is a broken
       reference. A name list would rot the moment a cell was retuned; this
       cannot, because it reads what the stylesheet actually says.

       THE AUTHORED VALUE MUST BE READ FROM THE STATE THAT IS APPLIED, and
       R304 is the proof - it came back VACUOUS on its first run because the
       classifier read the BASE declaration. Every one of these four cells is
       `inherit` in the light base, so a scheme overriding one with a broken
       var() was classified "by design" using a declaration the scheme had
       already replaced. The probe therefore resolves the WINNING declaration
       on <body> in the live state (last matching rule in document order - the
       three tiers here are body, body.dark-mode and body[data-theme], which
       ascend in both source order and specificity), falling back to :root for
       cells only declared there. Same disease as the mode-inherited probe in
       part 1: an assertion whose subject can be supplied by more than one
       source reports the disjunction unless it is told which one to ask. */
    const CSS_WIDE = ["inherit", "initial", "unset", "revert", "revert-layer"];
    const RESOLVE_PROBE = (names) => `(() => {
      const wanted = new Set(${JSON.stringify(names)});
      /* Winning authored value per cell, in the state that is applied right
         now - not the base's, which a scheme may have replaced. */
      const bodyWins = new Map(), rootWins = new Map();
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (!rule.style || !rule.selectorText) continue;
          let onBody = false, onRoot = false;
          try { onBody = document.body.matches(rule.selectorText); } catch (e) {}
          try { onRoot = document.documentElement.matches(rule.selectorText); } catch (e) {}
          if (!onBody && !onRoot) continue;
          for (const p of rule.style) {
            if (!wanted.has(p)) continue;
            (onBody ? bodyWins : rootWins).set(p, rule.style.getPropertyValue(p).trim());
          }
        }
      }
      const cs = getComputedStyle(document.body);
      const empty = [];
      for (const n of wanted) {
        if (cs.getPropertyValue(n).trim() !== '') continue;
        const authored = bodyWins.has(n) ? bodyWins.get(n)
          : rootWins.has(n) ? rootWins.get(n) : '__NO-DECLARATION-FOUND__';
        empty.push([n, authored]);
      }
      return JSON.stringify({ checked: wanted.size, empty: empty });
    })()`;
    for (const [mode, scheme] of [
      ["light", null],
      ["dark", null],
      ...SCHEME_STATES,
    ]) {
      await applySettled(mode, scheme, (scheme || mode + " default") + " (resolution)");
      const names = cover.requiredNames[mode].map(([k]) => k);
      const res = JSON.parse(await exec(RESOLVE_PROBE(names)));
      const broken = res.empty.filter(([, v]) => !CSS_WIDE.includes(v));
      const byDesign = res.empty.filter(([, v]) => CSS_WIDE.includes(v));
      check(
        `${scheme || mode + " default"}: every variable its mode's base declares resolves to a real value (or is a deliberate CSS-wide keyword)`,
        broken.length === 0 && res.checked === cover.baseSize[mode] && res.checked > 50,
        `checked ${res.checked} of ${cover.baseSize[mode]} declared cells; DECLARED BUT UNRESOLVABLE: ${broken.map(([n, v]) => n + " = " + v).join(", ") || "none"}; empty by design (winning declaration is a CSS-wide keyword, appearance covered by the frozen golden): ${byDesign.map(([n]) => n).join(", ") || "none"}`,
      );
    }

    /* RE-ATTACH THE WELCOME SCREEN FOR THE SCHEME SCANS.
       R295 IS THE PROOF THIS IS LOAD-BEARING: pointing clarity's
       --welcome-solid-bg back at the DEFAULT accent - precisely the defect 10c
       exists to catch - left this whole section GREEN, because by this point
       the census render had replaced #viewer's children and every welcome
       surface with them. Five variables that 10b REQUIRES each scheme to
       declare were being scanned in a document that contained no consumer of
       any of them.
       Attached as a direct child of #viewer, un-wrapped, because that is where
       it lives in index.html; no .welcome rule is scoped to a parent, so the
       markup styles identically either way, and appending it unchanged keeps
       what is scanned the PRODUCT's markup under the PRODUCT's rules. */
    const welcomeAttached = await exec(`(() => {
      if (!window.__foliaWelcomeHTML) return 0;
      const viewer = document.getElementById('viewer');
      viewer.insertAdjacentHTML('beforeend', window.__foliaWelcomeHTML);
      const node = viewer.lastElementChild;
      node.setAttribute('data-folia-welcome-probe', '1');
      return node.querySelectorAll('*').length;
    })()`);
    await applySettled("light", null, "light default (welcome re-attach)");
    const welcomeLive = JSON.parse(
      await exec(`(() => {
        const pick = (s, prop) => {
          const el = document.querySelector('[data-folia-welcome-probe] ' + s);
          return el ? getComputedStyle(el).getPropertyValue(prop) : null;
        };
        return JSON.stringify({
          dot: pick('.welcome-dot.active', 'background-color'),
          btn: pick('.welcome-open-btn', 'background-color'),
          readme: pick('.welcome-readme-btn', 'border-top-color'),
        });
      })()`),
    );
    /* TWO variables are probed, not one, and they are deliberately different
       cells: --welcome-solid-bg (the fill the dot and the Open button share)
       and --welcome-accent (the Readme button's border). A guard that reached
       only the first would leave the second free to be stranded while still
       reporting that the welcome surfaces were covered - which is the shape of
       the vacuity R295 exposed, one variable further along.
       The remaining three --welcome-* cells are :hover-only, so no resting
       probe can reach them at all; 10f's declaration-scope and retint
       assertions are what cover that class. */
    check(
      "the welcome surfaces are back in the DOM and really painting the welcome tokens",
      welcomeAttached > 20 &&
        !!welcomeLive.dot &&
        welcomeLive.dot === welcomeLive.btn &&
        /^rgb\(\d/.test(welcomeLive.dot) &&
        /^rgb\(\d/.test(welcomeLive.readme || ""),
      `attached ${welcomeAttached} nodes; .welcome-dot.active=${welcomeLive.dot} .welcome-open-btn=${welcomeLive.btn} (both read var(--welcome-solid-bg)) .welcome-readme-btn border=${welcomeLive.readme} (reads var(--welcome-accent)) - if any disagree, are transparent or are missing then 10c and 10d cover no welcome surface at all`,
    );

    // POSITIVE CONTROL FIRST, and it is not optional. 10c is an assertion of
    // ABSENCE, and an absence check fails OPEN: if the accent literals above
    // ever go stale - the default palette is retuned, or getComputedStyle
    // starts serialising differently - every scheme reports zero survivals and
    // the section passes by matching nothing. The defaults MUST hit them.
    //
    // PER NEEDLE, NOT IN AGGREGATE. `hits.length > 0` is a DISJUNCTION over
    // ten needles: nine could rot and the control would still report coverage
    // off the tenth. Measured, that was not hypothetical - half the list was
    // unreachable at rest, so half of 10c's stated coverage did not exist.
    // A needle that genuinely cannot be reached from a resting document is
    // EXCUSED BY NAME with the reason, and a stale excusal fails, so the map
    // cannot quietly grow into a way of ignoring the control.
    //
    // ALL THREE ENTRIES WERE MEASURED, not assumed: the probe named them and
    // each consumer was then read out of the stylesheet. Every one is a
    // :hover-only or ::selection paint, i.e. exactly the class of surface
    // getComputedStyle over document.querySelectorAll('*') structurally cannot
    // reach - which is why 10f (glow replay) and 10g (hover replay) exist
    // beside this section, and why an excusal here is a division of labour
    // rather than a hole. Their DECLARATION is separately required of every
    // scheme by 10b.
    const NEEDLE_EXCUSALS = {
      "rgba(61, 189, 198":
        "--accent-tint (.nav-btn:hover only) and --code-selection-bg (::selection, a pseudo-element no computed-style sweep can read)",
      "rgba(59, 191, 204":
        "--welcome-accent-tint, consumed only by .welcome-readme-btn:hover",
      "rgb(31, 138, 146)":
        "--welcome-solid-hover, consumed only by .welcome-open-btn:hover",
    };
    const ctlNeedles = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (accent control)");
      const ctl = JSON.parse(await exec(ACCENT_PROBE));
      for (const [k, v] of Object.entries(ctl.needles)) ctlNeedles[k] = (ctlNeedles[k] || 0) + v;
      check(
        `${mode} default: the accent literals 10c searches for are really painted (positive control)`,
        ctl.hits.length > 0 && ctl.scanned > 100,
        `scanned ${ctl.scanned} elements and found ${ctl.hits.length} default-accent paints; if this is 0 the literal list is stale and every scheme below passes vacuously`,
      );
    }
    const deadNeedles = Object.entries(ctlNeedles)
      .filter(([k, v]) => v === 0 && !(k in NEEDLE_EXCUSALS))
      .map(([k]) => k);
    check(
      "every accent needle is really painted by a default (per-needle positive control)",
      deadNeedles.length === 0,
      `these needles matched nothing in either default, so any surface stranded on them would go unreported: ${deadNeedles.join(", ")} | full tally ${JSON.stringify(ctlNeedles)}`,
    );
    const staleNeedleExcusals = Object.keys(NEEDLE_EXCUSALS).filter((k) => ctlNeedles[k] > 0);
    check(
      "every accent-needle excusal is still load-bearing",
      staleNeedleExcusals.length === 0,
      `these needles ARE reachable at rest now, so the excusal must be removed or it silently exempts whatever is added under that name next: ${staleNeedleExcusals.join(", ")}`,
    );
    for (const [mode, scheme] of SCHEME_STATES) {
      const applied = await applySettled(mode, scheme, scheme + " (accent)");
      check(
        `${scheme}: applying the scheme really moved the document into it`,
        applied === scheme + "/" + mode,
        `data-theme/mode came back as ${applied}`,
      );
      const surv = JSON.parse(await exec(ACCENT_PROBE));
      check(
        `${scheme}: no element still paints a DEFAULT accent colour`,
        surv.hits.length === 0,
        `${surv.hits.length} stranded surface(s) across ${surv.scanned} elements: ${surv.hits.join(" | ")}`,
      );
    }

    // ── 10d: a scheme may not make contrast worse than the default ───────────
    // Deliberately NOT an absolute WCAG bar. Folia's own defaults carry several
    // sub-4.5 cells (worst: white on the dark accent at 2.26) that cannot be
    // fixed without breaking the byte-exact-default requirement sections 1-9
    // enforce, so an absolute bar could only be met by changing the very thing
    // this suite exists to freeze. The bar that IS meetable, and is the one a
    // scheme author can actually violate, is RELATIVE: introduce no new
    // low-contrast cell, and make no existing one worse.
    const CONTRAST_PROBE = `(() => {
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function lum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      }
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const out = [];
      let painting = 0, invisible = 0;
      const seen = new Set();
      for (const el of document.querySelectorAll('*')) {
        /* Measure the element that actually PAINTS text - one with a DIRECT
           non-empty text node - and resolve its background from the nearest
           ancestor-or-self that is opaque. Both halves were arrived at by
           measurement and each fixes a failure of a cruder rule: keying on
           textContent reports containers at 1:1 (a div inherits a colour it
           never paints with), and using the element's OWN background misses
           every button whose label sits in a <span>, which is most of them. A
           semi-transparent background is skipped rather than alpha-blended -
           the blend is real, but the answer is only as good as the guess about
           what is behind it. */
        const paints = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!paints) continue;
        /* CUMULATIVE OPACITY, AND IT IS NOT OPTIONAL. An element with
           opacity < 1 is composited over its backdrop, so its RENDERED ink is
           o*fg + (1-o)*bg - not cs.color. Measured, the un-composited reading
           over-reports by a wide margin on real cells: .welcome-open-hint
           (opacity .75) reports 5.19 under clarity and RENDERS 3.61.
           o === 0 is a different case entirely and is EXCLUDED rather than
           measured: the element paints nothing at all, so compositing it
           yields fg === bg and a meaningless 1.00 ratio. Measured, 65 of the
           157 cells per state are the welcome slider's inactive slides at
           opacity 0; scoring them would bury every real cell under 65 false
           ones. The count is returned so the exclusion cannot go silent. */
        let o = 1;
        for (let a = el; a; a = a.parentElement) {
          const v = parseFloat(getComputedStyle(a).opacity);
          o *= isNaN(v) ? 1 : v;
        }
        if (o === 0) { invisible++; continue; }
        painting++;
        let bg = null;
        for (let a = el; a; a = a.parentElement) {
          const c = parse(getComputedStyle(a).backgroundColor);
          if (c && c.a >= 0.95) { bg = c; break; }
        }
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (!bg || !fg) continue;
        /* EVERY cell is emitted, not just the sub-4.5 ones. Filtering here was
           a structural defect: it made the RELATIVE comparisons unfailable
           whenever the absolute bar passed, because both drew their subjects
           from a list that the absolute bar had already emptied. Worse, the
           one case the relative bar was kept for - a cell degrading from 6.0
           to 4.6 - could never enter the list at all. The assertions filter at
           their own site now, and the ratios are carried UNROUNDED so a
           comparison is not decided by two decimal places. */
        const r = ratio(fg, bg);
        const ink = o >= 0.999 ? fg : {
          r: o * fg.r + (1 - o) * bg.r,
          g: o * fg.g + (1 - o) * bg.g,
          b: o * fg.b + (1 - o) * bg.b,
        };
        /* A colour-INDEPENDENT identity, so the same cell is recognisable
           across two states that deliberately paint it differently. Keying on
           the colours would make every scheme row look like a brand-new cell;
           keying on the tag name collapses the dozens of elements that share
           one - which is how the exit button's white-on-red hid inside the
           defaults while surfacing as the schemes' only cell. */
        let path = '', node = el;
        while (node && node.nodeType === 1) {
          const parent = node.parentElement;
          const idx = parent ? [...parent.children].indexOf(node) + 1 : 1;
          path = '>' + node.tagName.toLowerCase() + ':' + idx + path;
          node = parent;
        }
        if (seen.has(path)) continue;
        seen.add(path);
        const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
        out.push({
          path, sel, o: o, r: r, rEff: ratio(ink, bg),
          fg: 'rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ')',
          bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
        });
      }
      return JSON.stringify({ painting: painting, invisible: invisible, cells: out });
    })()`;

    const contrastBase = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (contrast baseline)");
      contrastBase[mode] = JSON.parse(await exec(CONTRAST_PROBE));
    }
    const buckets = (s) => ({
      painting: s.painting,
      invisible: s.invisible,
      dimmed: s.cells.filter((c) => c.o < 0.999).length,
      undimmed: s.cells.filter((c) => c.o >= 0.999).length,
    });
    check(
      "the contrast probe measured a substantial number of text-painting elements",
      contrastBase.light.painting >= 80 && contrastBase.dark.painting >= 80,
      `light ${contrastBase.light.painting}, dark ${contrastBase.dark.painting} - too few and the comparisons below are vacuous`,
    );
    // BOTH buckets must be occupied, because the bars below are SPLIT by this
    // very distinction: an empty dimmed bucket would make the inherited-dimming
    // assertion vacuous, and an empty undimmed bucket would gut the absolute
    // one. Measured today: 81 undimmed and 11 dimmed per state.
    check(
      "the defaults paint text at BOTH full and reduced opacity, so neither contrast bucket is empty",
      ["light", "dark"].every(
        (m) => buckets(contrastBase[m]).dimmed > 0 && buckets(contrastBase[m]).undimmed > 0,
      ),
      `light ${JSON.stringify(buckets(contrastBase.light))}, dark ${JSON.stringify(buckets(contrastBase.dark))}`,
    );
    // The defaults' own sub-AA cells are RECORDED rather than asserted away.
    // They are pre-existing and frozen; what matters is that the list is
    // non-empty, because an empty one would make the relative bars below
    // trivially true for every scheme. Measured: 10 undimmed sub-AA cells in
    // the light default, 4 in the dark - and 0 in all four schemes.
    check(
      "both defaults carry the pre-existing sub-AA cells the relative bars are measured against",
      ["light", "dark"].every(
        (m) => contrastBase[m].cells.filter((c) => c.rEff < 4.5).length > 0,
      ),
      `light ${contrastBase.light.cells.filter((c) => c.rEff < 4.5).length}, dark ${contrastBase.dark.cells.filter((c) => c.rEff < 4.5).length}`,
    );
    const show = (c) => `${c.sel} ${c.fg} on ${c.bg} o=${c.o.toFixed(2)} r=${c.r.toFixed(2)} rendered=${c.rEff.toFixed(2)}`;
    for (const [mode, scheme] of SCHEME_STATES) {
      await applySettled(mode, scheme, scheme + " (contrast)");
      const cur = JSON.parse(await exec(CONTRAST_PROBE));
      const baseByPath = new Map(contrastBase[mode].cells.map((c) => [c.path, c]));

      /* THE SCAN ITSELF IS ASSERTED FIRST, and it is not a threshold - it is
         an EQUALITY. Every assertion below is an assertion of ABSENCE over a
         scanned document, so all of them pass vacuously if the document shrinks
         between the baseline and the scheme state. That is not hypothetical:
         R295 was exactly this defect one state earlier, where the census render
         had removed the whole welcome screen before anything scanned for it.
         The six states are SUPPOSED to render identical DOM - only colours
         change - so equality is both the strongest available guard and the
         true statement. It also protects the path keying the two relative bars
         depend on, which degrades silently to "no shared cells" if the DOM
         shifts. Measured: 157 cells, 81 undimmed / 11 dimmed / 65 invisible,
         identical in all six states. */
      check(
        `${scheme}: scanned the very same document its mode's default baseline did`,
        JSON.stringify(buckets(cur)) === JSON.stringify(buckets(contrastBase[mode])) &&
          cur.cells.every((c) => baseByPath.has(c.path)),
        `scheme ${JSON.stringify(buckets(cur))} vs default ${JSON.stringify(buckets(contrastBase[mode]))}; ${cur.cells.filter((c) => !baseByPath.has(c.path)).length} cell(s) have no counterpart in the baseline`,
      );

      /* ABSOLUTE, over the ink the scheme actually controls at full strength.
         It applies ONLY to the four curated schemes, never to the defaults,
         which carry 10 (light) and 4 (dark) undimmed sub-AA cells the
         byte-exact requirement forbids touching.
         It was NOT assumed to be meetable. Measured, the schemes' only
         remaining undimmed sub-AA cell was the editor Exit button, white on
         the default's #e74c3c at 3.82 - a failure every scheme INHERITED from
         the base rather than chose, which is why the fix was to tokenise
         --danger-bg rather than to write an excusal here. All four now measure
         ZERO. */
      const undimmedFail = cur.cells.filter((c) => c.o >= 0.999 && c.rEff < 4.5);
      check(
        `${scheme}: every element it paints at full opacity meets WCAG AA (4.5:1)`,
        undimmedFail.length === 0,
        undimmedFail.map(show).join(" | "),
      );

      /* THE DIMMED CELLS ARE NOT EXCUSED - they are held to the same bar on
         the half the scheme owns. Base chrome dims secondary hints with
         `opacity` (.5 on .tools-shortcut/.submenu-arrow/.welcome-version, .7 on
         .shortcut, .75 on .welcome-open-hint). That dimming is frozen with the
         defaults, and it pushes those cells below AA no matter what colour sits
         underneath - measured, .tools-shortcut renders at 2.01 in the LIGHT
         DEFAULT. What a scheme does own is the colour pair it dims, so that is
         what is asserted: the choice must clear AA before the inherited
         dimming is applied. All four schemes pass; both DEFAULTS fail it at
         3.21 (.welcome-open-hint), which is exactly why the bar is scoped to
         schemes. */
      const dimmedChoice = cur.cells.filter((c) => c.o < 0.999 && c.r < 4.5);
      check(
        `${scheme}: every dimmed hint's colour choice meets WCAG AA before the inherited dimming`,
        dimmedChoice.length === 0,
        dimmedChoice.map(show).join(" | "),
      );

      /* THE HONEST RENDERED CLAIM. The two bars above are about what the
         scheme CHOSE; this one is about what a reader SEES, and it is the
         assertion that would have caught the defect that motivated all of
         this: .welcome-open-hint reports 5.19 under clarity and renders 3.61,
         so an absolute bar on cs.color alone certified as AA something that is
         not. It cannot demand AA outright - the dimming is frozen - so it
         demands PROVENANCE: anything rendering below AA must be a cell that
         renders below AA in this mode's default too. A scheme cannot introduce
         a sub-AA render, only inherit one. */
      const novelRenderFail = cur.cells.filter(
        (c) => c.rEff < 4.5 && !(baseByPath.get(c.path) && baseByPath.get(c.path).rEff < 4.5),
      );
      check(
        `${scheme}: every element that RENDERS below AA also renders below AA in its mode's default`,
        novelRenderFail.length === 0,
        novelRenderFail
          .map((c) => `${show(c)} (default rendered ${baseByPath.get(c.path) ? baseByPath.get(c.path).rEff.toFixed(2) : "ABSENT"})`)
          .join(" | "),
      );

      /* THE SECOND RELATIVE BAR, AND IT WAS REDUNDANT UNTIL IT WAS MEASURED
         AGAINST THE FIRST. Its previous form fired when a cell that met AA
         under the default fell below it - which is a STRICT SUBSET of the
         provenance bar above (base >= 4.5 and scheme < 4.5 satisfies both), so
         it could never fail alone and two assertions were guarding one
         property. That is worse than one assertion, because the second looks
         like independent coverage.
         What NEITHER of them could see is the cell that starts BELOW the bar.
         Provenance excuses any cell whose default is already sub-AA, and the
         dimmed-choice bar reads the pre-dimming pair, so a scheme could take
         .tools-shortcut from the light default's rendered 2.01 down to 1.2 and
         every assertion in 10d would stay green. The two bars are now DISJOINT
         by construction: provenance owns base >= 4.5, this owns base < 4.5.
         The asymmetry is deliberate and is the whole argument. Above AA a
         scheme may legitimately trade contrast for aesthetics - parchment
         moves a cell from 13.14 to 10.59 and that is a choice, not a defect.
         Below AA there is nothing left to trade. */
      const B_EPS = 0.01;
      const worsened = cur.cells.filter(
        (c) =>
          baseByPath.has(c.path) &&
          baseByPath.get(c.path).rEff < 4.5 &&
          c.rEff < baseByPath.get(c.path).rEff - B_EPS,
      );
      check(
        `${scheme}: no element that was ALREADY below AA in the default is made worse`,
        worsened.length === 0,
        worsened
          .map((c) => `${c.sel} rendered ${baseByPath.get(c.path).rEff.toFixed(2)} -> ${c.rEff.toFixed(2)} (${c.fg} on ${c.bg} o=${c.o.toFixed(2)})`)
          .join(" | "),
      );
    }
    /* The welcome markup deliberately STAYS attached through 10f and 10g.
       Removing it here - which is where it used to happen - silently narrowed
       10g's subject set: .welcome-open-btn:hover and .welcome-readme-btn:hover
       are two of the four hover rules in the whole product that paint an
       accent FILL, and they landed in `unmatched` for no reason other than
       ordering. Same disease as R295, one section further along: an assertion
       that walks the live DOM is only as wide as the DOM the suite has built
       by the time it runs. It is removed after 10g instead. */

    /* ── 10f: the accent GLOWS - the half of the appearance no golden can see ─
       Sections 1-9 sample surfaces in their RESTING state, because that is all
       getComputedStyle can reach. Every rule below paints only on :hover,
       :focus or ::after, so the twelve box-shadows that carry Folia's accent
       halo were invisible to the entire suite - and 10c caught the resulting
       gap only by accident, through the one glow that happens to sit on
       .welcome-open-btn.

       THE FROZEN VALUES BELOW RECORD A MEASUREMENT THAT IS NOT OBVIOUS AND IS
       EASY TO "TIDY" AWAY. Before tokenisation, ELEVEN of the twelve rules
       carried the LIGHT teal literal and had no body.dark-mode counterpart, so
       they painted the light halo in dark mode too. Exactly one -
       .app-update-btn.primary:hover - was overridden. Folding all twelve into
       a single per-mode accent token therefore LOOKS correct and silently
       changes the frozen dark default; --accent-glow-rgb is deliberately
       absent from the dark block for that reason, and R301 is that edit.

       Both halves are asserted separately, because a value that resolves
       correctly can do so from the wrong declaration: the CAUSE (which block
       declares the token) and the CONSEQUENCE (what the rules resolve to in
       each mode) fail under different accidents. */
    const GLOW_FAMILIES = {
      "--accent-glow-rgb": { light: "39, 158, 167", dark: "39, 158, 167" },
      "--accent-mode-glow-rgb": { light: "39, 158, 167", dark: "61, 189, 198" },
      "--danger-glow-rgb": { light: "231, 76, 60", dark: "231, 76, 60" },
    };
    /* THE FROZEN INVENTORY - every glow this app paints, by selector, by the
       property that paints it, and by the alpha it paints at.
       A COUNT IS NOT AN INVENTORY, and that distinction is the whole reason
       this is a table rather than a floor. A floor of 13 is satisfied when a
       hover consumer is deleted and any other tokenised rule is duplicated in
       its place, and a SET of alphas is satisfied when two rules exchange
       theirs - neither of which any other assertion in the suite can see,
       because every one of these states is a :hover, :focus or ::after that
       getComputedStyle cannot reach and no screenshot of a resting page shows.
       The alphas live at the USE SITES on purpose: the token carries an rgb
       triple so that one scheme value serves six halo strengths, which also
       makes an alpha the one part of a glow a scheme author cannot reach. */
    const GLOW_INVENTORY = [
      ["--accent-glow-rgb", "body.drop-active::after", "background", "0.08"],
      ["--accent-glow-rgb", ".btn:hover", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".editor-save-btn:hover", "box-shadow", "0.3"],
      ["--danger-glow-rgb", ".editor-exit-btn:hover", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".welcome-open-btn", "box-shadow", "0.35"],
      ["--accent-glow-rgb", ".welcome-open-btn:hover", "box-shadow", "0.45"],
      ["--accent-glow-rgb", ".welcome-open-btn:active", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".search-input:focus", "box-shadow", "0.2"],
      ["--accent-glow-rgb", ".file-update-btn.reload:hover", "box-shadow", "0.3"],
      ["--accent-mode-glow-rgb", ".app-update-btn.primary:hover", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".note-dialog-input:focus", "box-shadow", "0.15"],
      ["--accent-glow-rgb", ".note-dialog-textarea:focus", "box-shadow", "0.15"],
      ["--accent-glow-rgb", ".note-dialog-btn.primary:hover", "box-shadow", "0.3"],
    ];

    /* Collected from the LIVE stylesheet rather than listed here: a hard-coded
       selector list silently stops covering a rule that is renamed, and stops
       growing when a thirteenth glow is added.
       SCANNED ACROSS PROPERTIES, and that was not the first version. Filtering
       on box-shadow alone quietly dropped .file-update-btn's `background:
       rgba(var(--accent-glow-rgb), 0.08)` - a glow consumer that simply is not
       a shadow - and the ONLY symptom was a missing alpha in the frozen list
       below. The retint and fidelity assertions were happily reporting a clean
       sweep of a subject set one rule short. */
    const GLOW_PROPS = {
      "box-shadow": "box-shadow",
      background: "background-color",
      "background-color": "background-color",
      border: "border-top-color",
      "border-color": "border-top-color",
      color: "color",
      outline: "outline-color",
      "outline-color": "outline-color",
    };
    const glowRules = JSON.parse(
      await exec(`(() => {
        const FAMILIES = ${JSON.stringify(Object.keys(GLOW_FAMILIES))};
        const PROPS = ${JSON.stringify(Object.keys(GLOW_PROPS))};
        const out = [];
        const walk = (rules) => {
          for (const rule of rules) {
            if (rule.style && rule.selectorText) {
              for (const prop of PROPS) {
                const v = rule.style.getPropertyValue(prop);
                if (!v) continue;
                const fam = FAMILIES.filter((f) => v.includes(f));
                if (fam.length === 1) out.push({ sel: rule.selectorText.trim(), prop, family: fam[0], declared: v.trim() });
                else if (fam.length > 1) out.push({ sel: rule.selectorText.trim(), prop, family: 'MIXED:' + fam.join('+'), declared: v.trim() });
              }
            }
            if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
          }
        };
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          if (rules) walk(rules);
        }
        return JSON.stringify(out);
      })()`),
    );
    /* Set equality in BOTH directions against the frozen inventory. A missing
       tuple is a consumer that stopped being tokenised or was renamed; an
       unexpected one is a glow nobody decided to add. Both need a human, and
       both are silent everywhere else. */
    const glowKey = (family, sel, prop, alpha) => `${sel} {${prop}} ${family} @${alpha}`;
    const liveGlowKeys = glowRules.map((r) => {
      const m = /,\s*([0-9.]+)\s*\)/.exec(r.declared);
      return glowKey(r.family, r.sel, r.prop, m ? String(parseFloat(m[1])) : "NO-ALPHA");
    });
    const frozenGlowKeys = GLOW_INVENTORY.map((row) => glowKey(row[0], row[1], row[2], row[3]));
    const glowMissing = frozenGlowKeys.filter((k) => !liveGlowKeys.includes(k));
    const glowUnexpected = liveGlowKeys.filter((k) => !frozenGlowKeys.includes(k));
    check(
      "the glow rules are exactly the frozen inventory - same selectors, same properties, same alphas",
      glowMissing.length === 0 &&
        glowUnexpected.length === 0 &&
        liveGlowKeys.length === frozenGlowKeys.length &&
        glowRules.every((r) => !r.family.startsWith("MIXED")),
      `missing: [${glowMissing.join(" | ")}] unexpected: [${glowUnexpected.join(" | ")}] (live ${liveGlowKeys.length}, frozen ${frozenGlowKeys.length})`,
    );

    const resolveGlows = async (mode, scheme, label) => {
      await applySettled(mode, scheme, label);
      return JSON.parse(
        await exec(`(() => {
          const RULES = ${JSON.stringify(glowRules)};
          const READ = ${JSON.stringify(GLOW_PROPS)};
          const host = document.createElement('div');
          host.style.position = 'absolute'; host.style.left = '-99999px';
          document.body.appendChild(host);
          const els = RULES.map((r) => {
            const el = document.createElement('div');
            el.style.setProperty(r.prop, r.declared);
            host.appendChild(el);
            return el;
          });
          const out = els.map((el, i) => getComputedStyle(el).getPropertyValue(READ[RULES[i].prop]));
          host.remove();
          return JSON.stringify(out);
        })()`),
      );
    };

    /* An rgb triple is compared, not the whole declaration: the offsets and
       blur radii belong to the rule and are identical by construction, while
       the COLOUR is the only thing the token moves. */
    const tripleOf = (s) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || "");
      return m ? `${m[1]}, ${m[2]}, ${m[3]}` : null;
    };
    const glowByMode = {};
    for (const mode of ["light", "dark"]) {
      const got = await resolveGlows(mode, null, `${mode} default (glow probe)`);
      glowByMode[mode] = got;
      const wrong = glowRules
        .map((r, i) => ({ ...r, got: tripleOf(got[i]) }))
        .filter((r) => r.got !== GLOW_FAMILIES[r.family][mode]);
      check(
        `${mode} default: every accent glow resolves to its frozen pre-theme colour`,
        wrong.length === 0,
        wrong
          .map((r) => `${r.sel} resolved ${r.got}, frozen ${GLOW_FAMILIES[r.family][mode]}`)
          .join(" | "),
      );
    }
    /* THE CAUSE, asserted separately from the consequence above. The eleven
       --accent-glow-rgb rules resolve identically in both modes only because
       the token is declared ONCE, outside the dark block. Redeclaring it in
       body.dark-mode is a one-line edit that looks like an omission being
       fixed, and the resolved-value assertion is what it breaks - but only
       this one names the reason. */
    const glowScope = JSON.parse(
      await exec(`(() => {
        const FAMILIES = ${JSON.stringify(Object.keys(GLOW_FAMILIES))};
        const out = {};
        for (const f of FAMILIES) out[f] = [];
        /* The media condition is carried down the walk, because this is an
           assertion about SCOPE and a redeclaration inside
           @media (prefers-color-scheme: dark) { :root { ... } } is a dark-mode
           declaration wearing a selector that does not say so. */
        const walk = (rules, cond) => {
          for (const rule of rules) {
            const at = rule.media ? (cond ? cond + ' && ' : '') + '@media ' + rule.conditionText : cond;
            if (rule.style && rule.selectorText) {
              for (const f of FAMILIES) {
                if (rule.style.getPropertyValue(f)) {
                  out[f].push((at ? at + ' ' : '') + rule.selectorText.trim());
                }
              }
            }
            if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, at);
          }
        };
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          if (rules) walk(rules, '');
        }
        return JSON.stringify(out);
      })()`),
    );
    /* Scope-COMPLETE on purpose: any selector carrying .dark-mode whatever it
       is attached to, plus anything nested under a dark colour-scheme query.
       The assertion is specifically about where a declaration lives, so a
       matcher that only recognises the one spelling in use today would report
       an absence as satisfied - the failure mode this project has hit before. */
    const darkDecl = (f) =>
      (glowScope[f] || []).filter(
        (s) => /\.dark-mode\b/.test(s) || /prefers-color-scheme:\s*dark/.test(s),
      );
    /* EXACTLY ONE, not "at least one". The scheme blocks declare this token
       too, so a floor of 1 is satisfied by them alone - deleting the :root
       declaration outright would have passed this assertion under its own
       name, leaving it to a sibling to report a defect this one is named for. */
    const baseDecl = (f) =>
      (glowScope[f] || []).filter((s) => s === ":root" || s === "body");
    check(
      "the mode-invariant glow token is declared once, outside the dark block",
      baseDecl("--accent-glow-rgb").length === 1 &&
        darkDecl("--accent-glow-rgb").length === 0 &&
        darkDecl("--danger-glow-rgb").length === 0,
      `--accent-glow-rgb declared by [${glowScope["--accent-glow-rgb"].join(", ")}], of which ${baseDecl("--accent-glow-rgb").length} at base scope (:root/body, must be exactly 1); dark-mode declarations: accent=[${darkDecl("--accent-glow-rgb").join(", ")}] danger=[${darkDecl("--danger-glow-rgb").join(", ")}] - eleven rules painted the LIGHT teal in dark mode before the theme system existed, so declaring this per mode changes the frozen dark default with nothing else in the suite able to see it`,
    );
    check(
      "the one genuinely mode-varying glow IS declared per mode",
      darkDecl("--accent-mode-glow-rgb").length === 1,
      `--accent-mode-glow-rgb dark declarations: [${darkDecl("--accent-mode-glow-rgb").join(", ")}] - exactly .app-update-btn.primary:hover differed by mode before tokenisation, and dropping that override would flatten it to the light halo`,
    );

    /* A glow a scheme cannot reach is the stranded-accent defect of 10c in a
       state no screenshot of a resting page can show. */
    for (const [mode, scheme] of SCHEME_STATES) {
      const got = await resolveGlows(mode, scheme, `${scheme} (glow probe)`);
      const stranded = glowRules
        .map((r, i) => ({ ...r, got: tripleOf(got[i]) }))
        .filter((r) => !r.got || r.got === GLOW_FAMILIES[r.family][mode]);
      check(
        `${scheme}: every accent glow is retinted, none left on the default halo`,
        stranded.length === 0,
        stranded
          .map((r) => `${r.sel} still ${r.got} (the ${mode} default for ${r.family})`)
          .join(" | "),
      );
    }

    /* THE RE-ADDED LITERAL, which every other assertion in this section is
       structurally blind to. A rule written as
         body.dark-mode .btn:hover { box-shadow: 0 2px 8px rgba(61,189,198,0.3) }
       carries no token name, so the collector never sees it, the inventory
       never misses it, the scope probe never reads it and the resting-state
       golden of sections 1-9 cannot reach a :hover rule at all. It would paint
       the pre-theme halo under every scheme with nothing failing.
       The sweep is over DECLARATIONS rather than the file's text so a
       reformat cannot defeat it, and CUSTOM PROPERTIES ARE EXCLUDED because
       the frozen triples legitimately live in exactly one place - the token
       declarations themselves (--accent-tint, --code-selection-bg and the
       three glow triples). Excluding by property KIND rather than by a list of
       names is what stops this going stale when a token is added. */
    /* THE FROZEN ACCENT FAMILY, as triples rather than as spellings. The
       needles are DERIVED from these so the spellings cannot drift apart, and
       so a fourth family member is one line rather than hand-written strings.
         39,158,167   #279EA7  the light default accent
         61,189,198   #3DBDC6  the dark default accent
         231,76,60    #e74c3c  the frozen danger red
         59,191,204   #3bbfcc  the dark welcome accent (two hex digits off the
                               app accent - see the note at styles.css:1659)

       THE HEX NEEDLE IS HERE BECAUSE AN EARLIER VERSION OF THIS COMMENT WAS
       WRONG, AND WRONG IN THE WAY THAT MATTERS. It recorded, as a measured
       fact, that Chromium canonicalises colour values entering the CSSOM - so
       `color: #279ea7` reads back as `rgb(39, 158, 167)` - and concluded that
       a hex needle could never match. The measurement was real but the
       conclusion did not hold, because CANONICALISATION DOES NOT HAPPEN TO A
       VALUE CONTAINING `var()`: such a value is stored as an unparsed token
       sequence. Measured, on this document:
         color: var(--nope, #279ea7)   -> reads back "var(--nope, #279ea7)"
         color: #279EA7                -> reads back "rgb(39, 158, 167)"
       So the ONE spelling that survives into the CSSOM unchanged is a hex
       inside a var() fallback - and `var(--primary-color, #279EA7)` is exactly
       the shape this codebase already writes (custom-styles.css:456 ships
       `var(--primary-color, #2d9cdb)`). It re-freezes the default accent under
       every scheme, and the old needle set could not see it. Hex is matched
       case-insensitively: the product spells it #279EA7, this list spells it
       lower. */
    const ACCENT_FAMILY = [
      [39, 158, 167],
      [61, 189, 198],
      [231, 76, 60],
      [59, 191, 204],
    ];
    /* An accent literal inside a print-only at-rule is the one legitimate
       case, and it is legitimate for a reason 10i proves rather than asserts:
       the export park removes `data-theme` before printToPDF captures, so
       every theme state prints the shipped light default. These two rules
       repaint a dark-mode link and blockquote in the LIGHT accent because the
       dark accent is chosen to sit on a dark surface, not on forced-white
       paper. They are excused BY NAME as well as by context, so a NEW print
       literal still has to be looked at. */
    const LITERAL_EXCUSALS = {
      "body.dark-mode #viewer a|color":
        "print forces the paper-legible light accent for dark-mode links",
      "body.dark-mode #viewer blockquote|border-left-color":
        "print forces the paper-legible light accent for dark-mode quote rules",
    };
    const literalUses = JSON.parse(
      await exec(`(() => {
        const FAMILY = ${JSON.stringify(ACCENT_FAMILY)};
        const NEEDLES = [];
        for (const f of FAMILY) {
          NEEDLES.push('rgb(' + f[0] + ', ' + f[1] + ', ' + f[2] + ')');
          NEEDLES.push('rgba(' + f[0] + ', ' + f[1] + ', ' + f[2]);
          NEEDLES.push('#' + f.map(function (n) {
            return n.toString(16).padStart(2, '0');
          }).join(''));
        }
        const hunt = (text) => {
          const flat = text.replace(/\\s+/g, ' ').toLowerCase();
          return NEEDLES.some((n) => flat.indexOf(n) !== -1);
        };
        /* CUSTOM PROPERTIES ARE EXCLUDED TEXTUALLY rather than structurally,
           because detection now reads cssText (see below) and cssText carries
           the token declarations too. The frozen triples legitimately live in
           exactly one place - the token declarations themselves - so removing
           every '--name: value' declaration is the same exclusion the old
           prop.startsWith('--') test made, expressed on the serialised form.
           The self-check below plants a custom property holding an accent and
           requires it NOT to be reported, which is the negative control this
           swap owes. */
        const stripCustom = (cssText) =>
          cssText.replace(/(^|;)\\s*--[^:;]+:[^;]*/g, '$1');
        const sweep = () => {
          const hits = [];
          let sheets = 0, unreadable = 0, rules = 0, decls = 0;
          const seen = [];
          const walk = (rules_, cond, kfName) => {
            for (const rule of rules_) {
              /* A @keyframes STEP has .style but no .selectorText - it carries
                 .keyText instead - so gating the walk on selectorText alone
                 silently dropped every keyframe declaration. Measured: 14 such
                 rules exist in this document, and styles.css already animates
                 box-shadow (notePulse). An accent pulse would have been a
                 stranded accent no assertion in 10c, 10d, 10f or 10g could
                 see. The enclosing @keyframes NAME is carried down because
                 keyText alone ('50%') names nothing an excusal or a failure
                 message could be read against. */
              const name = rule.selectorText
                || (rule.keyText ? '@keyframes ' + (kfName || '<anonymous>') + ' ' + rule.keyText : null);
              if (rule.style && name) {
                rules++;
                /* DETECTION READS cssText, NOT THE LONGHAND LIST, and that is
                   the whole point. A shorthand whose value contains var() is
                   stored as a pending-substitution value: Chromium exposes it
                   under the SHORTHAND name only, and every longhand reads back
                   as the empty string. Measured on this document:
                     border: 1.5px solid var(--x, rgb(59, 191, 204))
                       -> 17 longhands, ALL EMPTY, needle never matched
                   styles.css already writes 'border: 1.5px solid
                   var(--welcome-accent)', so this is the live shape, not a
                   contrived one. The longhand loop below still runs, but only
                   to name the offending property for the excusal key. */
                const scanText = stripCustom(rule.style.cssText || '');
                let ruleHit = hunt(scanText);
                let matchedProp = null;
                for (let i = 0; i < rule.style.length; i++) {
                  const prop = rule.style[i];
                  if (prop.startsWith('--')) continue;
                  const v = rule.style.getPropertyValue(prop);
                  if (v !== '') decls++;
                  if (!matchedProp && v !== '' && hunt(v)) matchedProp = prop;
                }
                if (ruleHit) {
                  hits.push({
                    key: name.trim() + '|' + (matchedProp || '<shorthand or var() fallback>'),
                    text: name.trim() + ' { ' + scanText.trim() + ' }',
                    conds: cond.slice(),
                    /* Measured in the live screen context rather than inferred
                       from the condition text: an empty chain applies, and a
                       chain applies only if EVERY enclosing condition does. */
                    appliesOnScreen: cond.every((c) => window.matchMedia(c).matches),
                  });
                }
              }
              if (rule.cssRules && rule.cssRules.length) {
                walk(
                  rule.cssRules,
                  rule.conditionText ? cond.concat([rule.conditionText]) : cond,
                  rule.name || kfName
                );
              }
            }
          };
          for (const sheet of document.styleSheets) {
            sheets++;
            let r; 
            try { r = sheet.cssRules; } catch (e) { unreadable++; continue; }
            seen.push((sheet.href || '<inline>').split('/').pop());
            if (r) walk(r, [], null);
          }
          return { hits: hits, sheets: sheets, unreadable: unreadable, rules: rules, decls: decls, seen: seen };
        };
        const before = sweep();
        /* POSITIVE CONTROL. A sweep that has stopped matching reports a clean
           product, so every spelling a re-added literal could plausibly be
           written in is planted and required to be caught - including the two
           the previous needle set was measured to miss. The '-clean' and
           '-custom' rules are NEGATIVE controls: an over-broad sweep that
           reported every rule, or one that stopped excluding token
           declarations, would catch them and fail this check. */
        const probe = document.createElement('style');
        probe.textContent =
          '.folia-literal-selfcheck-hex { color: #279ea7 }' +
          '.folia-literal-selfcheck-upperhex { color: #3DBDC6 }' +
          '.folia-literal-selfcheck-rgb { color: rgb(61, 189, 198) }' +
          '.folia-literal-selfcheck-rgba { box-shadow: 0 0 8px rgba(231, 76, 60, 0.3) }' +
          '.folia-literal-selfcheck-varfallback { color: var(--folia-unset, #279EA7) }' +
          '.folia-literal-selfcheck-shorthand { border: 1px solid var(--folia-unset, rgb(59, 191, 204)) }' +
          '@keyframes foliaLiteralSelfcheckKf { 50% { box-shadow: 0 0 8px rgba(39, 158, 167, 0.3) } }' +
          '.folia-literal-selfcheck-clean { color: rgb(1, 2, 3) }' +
          '.folia-literal-selfcheck-custom { --folia-selfcheck-token: #279ea7 }';
        document.head.appendChild(probe);
        const planted = sweep();
        probe.remove();
        const after = sweep();
        const plantedKeys = planted.hits
          .map((h) => h.key)
          .filter((k) => k.toLowerCase().indexOf('selfcheck') !== -1);
        return JSON.stringify({
          hits: before.hits,
          sheets: before.sheets,
          unreadable: before.unreadable,
          rules: before.rules,
          decls: before.decls,
          seen: before.seen,
          plantedKeys: plantedKeys,
          afterCount: after.hits.length,
        });
      })()`),
    );
    const CONTROL_SPELLINGS = ["hex", "upperhex", "rgb", "rgba", "varfallback", "shorthand", "kf"];
    const caughtSpellings = CONTROL_SPELLINGS.filter((s) =>
      literalUses.plantedKeys.some((k) =>
        s === "kf" ? k.toLowerCase().includes("selfcheckkf ") : k.toLowerCase().includes(`selfcheck-${s}|`),
      ),
    );
    const falsePositives = literalUses.plantedKeys.filter((k) => /-(clean|custom)\|/.test(k));
    check(
      "10f: the literal sweep catches every spelling a re-added accent can wear (positive control)",
      caughtSpellings.length === CONTROL_SPELLINGS.length &&
        falsePositives.length === 0 &&
        literalUses.afterCount === literalUses.hits.length,
      `caught ${caughtSpellings.length}/${CONTROL_SPELLINGS.length} spellings [${caughtSpellings.join(", ")}], missed [${CONTROL_SPELLINGS.filter((s) => !caughtSpellings.includes(s)).join(", ")}]; ${falsePositives.length} negative control(s) wrongly caught [${falsePositives.join(", ")}]; after removal ${literalUses.afterCount} vs baseline ${literalUses.hits.length}`,
    );
    /* THE VACUITY GUARD IS A NAMED RELATIONSHIP, NOT A THRESHOLD. A scan-count
       floor is satisfiable by the wrong stylesheet, and it cannot notice that
       one product sheet became unreadable and took all of its declarations
       with it - an absence that would otherwise be reported as cleanliness. */
    const wantSheets = ["styles.css", "custom-styles.css"];
    const missingSheets = wantSheets.filter((s) => !literalUses.seen.includes(s));
    check(
      "10f: the literal sweep actually read both product stylesheets",
      missingSheets.length === 0 && literalUses.unreadable === 0,
      `missing [${missingSheets.join(", ")}], ${literalUses.unreadable} unreadable of ${literalUses.sheets} sheet(s); read [${literalUses.seen.join(", ")}]`,
    );
    const literalUnexcused = literalUses.hits.filter((h) => !LITERAL_EXCUSALS[h.key]);
    const literalExcused = literalUses.hits.filter((h) => LITERAL_EXCUSALS[h.key]);
    check(
      "no rule paints a frozen accent literal outside a custom-property declaration",
      literalUnexcused.length === 0,
      `${literalUnexcused.length} literal use(s) across ${literalUses.rules} rules / ${literalUses.decls} declarations: ${literalUnexcused.map((h) => h.text).join(" | ")}`,
    );
    /* THE EXCUSAL GATE MEASURES WHETHER THE RULE APPLIES, RATHER THAN READING
       THE WORD "print" IN ITS CONDITION. Measured on screen, in this window:
         @media print          conditionText "print"          matches FALSE
         @media screen, print  conditionText "screen, print"  matches TRUE
         @media not print      conditionText "not print"      matches TRUE
       A substring test excuses all three. Both halves are required: naming
       print keeps a literal from hiding behind any old never-matching at-rule
       (which is what R331 plants), and not applying on screen keeps
       `screen, print` from being waved through (R333). */
    const badContext = literalExcused.filter(
      (h) => !h.conds.some((c) => /\bprint\b/.test(c)) || h.appliesOnScreen,
    );
    check(
      "10f: every excused accent literal is in an at-rule that names print and does not apply on screen",
      badContext.length === 0,
      badContext
        .map(
          (h) =>
            `${h.text} under [${h.conds.join(" / ") || "no at-rule"}]${h.appliesOnScreen ? " which APPLIES ON SCREEN" : ""}`,
        )
        .join(" | "),
    );
    const staleLiteralExcusals = Object.keys(LITERAL_EXCUSALS).filter(
      (k) => !literalUses.hits.some((h) => h.key === k),
    );
    check(
      "10f: no accent-literal excusal is stale",
      staleLiteralExcusals.length === 0,
      `${staleLiteralExcusals.join(", ")} no longer paint a frozen accent literal, so the excusal now only hides a future one`,
    );

    await applySettled("light", null, "restore after glow probe");

    // ── 10g: contrast in the states getComputedStyle cannot reach ───────────
    // 10d samples RESTING surfaces, because that is all a sweep over
    // document.querySelectorAll('*') can see. Every :hover and :focus repaint
    // in the product is therefore outside its subject set - and that is not a
    // theoretical gap: .search-btn:hover was the ONE accent-background rule in
    // the stylesheet that did not also set --on-accent-fg, and it measured
    // 1.86:1 under abyss and 1.75:1 under ember, worse than the frozen
    // defaults' worst cell anywhere. Ten sections of assertions reported a
    // clean sweep over it.
    //
    // THE INSTRUMENT IS REPLAY, not a forced pseudo-class: the rule's own
    // declarations are written onto the REAL element as inline styles, which
    // beat every author rule, so what is measured is the element's resting
    // cascade with the hover rule applied on top - which is what :hover does.
    // Transitions are pinned off during the replay for the reason recorded at
    // settleTransitions(): a colour read while a transition is running is the
    // PREVIOUS state's colour, and here the replay itself is what starts it.
    const HOVER_PROBE = `(() => {
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function lum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      }
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      /* A TRANSLUCENT FILL IS COMPOSITED, NOT SKIPPED. The first version of
         this walk took the nearest ancestor with alpha >= 0.95 as the surface,
         which silently discarded the very layer the hover rule had just
         painted: .welcome-readme-btn:hover paints its accent tint at alpha
         0.10, so the ink was scored against the PAGE behind it and the ratio
         came out flattering. Compositing every layer from the backdrop forward
         measures what the eye actually receives. */
      function over(fg, bg) {
        return {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        };
      }
      function surfaceOf(el) {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) {
            stack.push(c);
            if (c.a >= 0.999) break;
          }
        }
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      }
      /* THE ACCENT IS IDENTIFIED BY CHROMA, NOT BY NAME. An earlier gate
         compared the element's fill against the resolved --primary-color, so
         it saw exactly one of the product's accent variables; --accent-hover,
         --danger-bg-hover and --welcome-solid-hover all repaint elements and
         were invisible to it. Naming the family instead would trade one stale
         list for a longer one and would need a separate revert per limb.
         What actually matters is not WHICH variable painted the surface but
         whether the ink still has a relationship to it: ink chosen against a
         NEUTRAL surface has none once a SATURATED one is painted underneath.
         So the predicate is measured - achromatic rest, chromatic fill - and
         one revert proves the whole gate. */
      const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      /* focus-within IS LISTED BEFORE focus AND THAT IS NOT COSMETIC. The
         alternation is used both to DETECT a state selector and to strip it
         back to a bare one, and \\b sits happily between "focus" and the "-" of
         "focus-within". With the shorter alternative first, ":focus-within"
         strips to "-within" - a syntactically invalid selector, so
         querySelector throws, the rule lands in "unmatched", and a real hover
         surface leaves the subject set without anything failing. */
      const STATE = /:(hover|focus-within|focus-visible|focus|active)\\b/;
      const STATE_G = /:(hover|focus-within|focus-visible|focus|active)\\b/g;
      const collected = [];
      /* A GROUPING RULE THAT DOES NOT APPLY MUST NOT CONTRIBUTE SUBJECTS.
         @media print carries its own hover rules; replaying them on screen
         measures a pairing the reader can never see, and - worse - a print
         rule that legitimately drops a background would be scored as a
         stranded ink. matches() asks the engine rather than parsing the
         condition, so a future @supports or nested @media needs no new code. */
      const groupApplies = (rule) => {
        if (rule.media && rule.conditionText) {
          try { return window.matchMedia(rule.conditionText).matches; }
          catch (e) { return true; }
        }
        return true;
      };
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.style && rule.selectorText && STATE.test(rule.selectorText)) {
            /* A pseudo-ELEMENT paints no text of its own and cannot be
               selected, so replaying onto it is impossible; ::after glows are
               10f's subject, not this section's. */
            if (rule.selectorText.indexOf('::') === -1) {
              /* DECLARATIONS ARE PARSED OUT OF cssText, NOT read off
                 rule.style, and that is load-bearing rather than stylistic.
                 A SHORTHAND HOLDING var() IS A PENDING-SUBSTITUTION VALUE: the
                 CSSOM enumerates it as its longhands and serialises every one
                 of them as the EMPTY STRING. So the obvious loop over
                 rule.style[i] silently DROPS "background: var(--primary-color)"
                 - which is how every accent fill in the product is written.
                 Measured before this was fixed: .btn:hover replayed its accent
                 INK onto the element's RESTING grey and reported 1.23:1, a
                 fabricated failure, while the real accent-fill rules it exists
                 to check were never exercised at all. Same serialisation trap
                 the default-fidelity probe hit on border-color, in the other
                 direction. */
              const decls = [];
              const block = rule.cssText.slice(
                rule.cssText.indexOf('{') + 1, rule.cssText.lastIndexOf('}'));
              let depth = 0, quote = null, cur = '';
              const flush = () => {
                const t = cur.trim(); cur = '';
                if (!t) return;
                const c = t.indexOf(':');
                if (c <= 0) return;
                decls.push([t.slice(0, c).trim().toLowerCase(), t.slice(c + 1).trim()]);
              };
              for (const ch of block) {
                if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
                if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                else if (ch === ';' && depth === 0) { flush(); continue; }
                cur += ch;
              }
              flush();
              const paints = decls.some((d) => d[0] === 'background' ||
                d[0] === 'background-color' || d[0] === 'color' ||
                d[0] === 'stroke' || d[0] === 'fill');
              /* THE SELECTOR LIST IS SPLIT AND FILTERED PER PART. A rule
                 written ".a, .b:hover" tests true as a whole, and stripping
                 states across the whole string yields ".a, .b" - so ".a", an
                 element this rule never puts into a state, is replayed as if
                 it were a hover subject. Only the parts that carry a state are
                 kept. */
              if (paints) {
                const parts = [];
                let d2 = 0, q2 = null, buf = '';
                for (const ch of rule.selectorText) {
                  if (q2) { if (ch === q2) q2 = null; buf += ch; continue; }
                  if (ch === '"' || ch === "'") { q2 = ch; buf += ch; continue; }
                  if (ch === '(' || ch === '[') d2++;
                  else if (ch === ')' || ch === ']') d2--;
                  else if (ch === ',' && d2 === 0) { parts.push(buf); buf = ''; continue; }
                  buf += ch;
                }
                parts.push(buf);
                for (const p of parts) {
                  const t = p.trim();
                  if (t && STATE.test(t)) collected.push({ sel: t, decls: decls });
                }
              }
            }
          }
          if (rule.cssRules && rule.cssRules.length && groupApplies(rule)) walk(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (rules) walk(rules);
      }
      const cells = [];
      const unmatched = [];
      let matched = 0;
      let declaredBg = 0, landedBg = 0;
      const droppedBg = [];
      /* The accent is resolved through the ENGINE rather than parsed out of
         the custom property, so the comparison below is between two values the
         engine produced and serialised the same way. */
      /* Chroma of every resting surface and every state fill, so the
         classifier's own separation can be asserted rather than assumed. */
      const chromaBands = [];
      const accentNoInk = [];
      const capped = [];
      const HOVER_ELS_CAP = 40;
      for (const r of collected) {
        const bare = r.sel.replace(STATE_G, '');
        let els = [];
        try { els = Array.prototype.slice.call(document.querySelectorAll(bare)); }
        catch (e) { els = []; }
        if (!els.length) { unmatched.push(r.sel); continue; }
        /* EVERY MATCH IS MEASURED, NOT THE FIRST. A single querySelector makes
           the subject set depend on document order: .context-menu-item:hover
           matches a dozen rows, and if the first happens to carry an icon while
           a later one carries only text, the text pairing is never scored.
           Measured: this took the subject set from 30 cells to 146.
           THE CAP IS A SAFETY VALVE, NOT A SAMPLING STRATEGY, and an assertion
           requires it never to fire. The widest rule in the product today
           reaches 30 nodes (.context-menu-item:hover), so a rule arriving at 40
           is one whose reach has changed, and the right response is to look at
           it rather than to quietly measure a prefix and report a clean sweep
           over a subject set that silently shrank. */
        if (els.length > HOVER_ELS_CAP) { capped.push(r.sel + ' x' + els.length); }
        els = els.slice(0, HOVER_ELS_CAP);
        matched++;
        for (const el of els) {
        const restSurf = surfaceOf(el);
        const saved = el.getAttribute('style');
        el.style.setProperty('transition', 'none', 'important');
        /* A VALUE CARRYING !important IS REJECTED BY setProperty AND THE
           DECLARATION SILENTLY DOES NOTHING. cssText hands back the priority
           inside the value string, so "#fff !important" must be split into the
           value and the priority argument before it will land. Everything here
           is replayed at "important" anyway, so the priority is not otherwise
           load-bearing - what matters is that the value stops being
           syntactically invalid. Uncaught, this is the fill-dropping failure
           the positive control below exists to name. */
        for (const d of r.decls) {
          el.style.setProperty(d[0], d[1].replace(/\\s*!\\s*important\\s*$/i, ''), 'important');
        }
        /* POSITIVE CONTROL FOR THE REPLAY ITSELF. Every measurement below is a
           pairing of an ink with a fill, and a replay that silently drops the
           fill produces a fully-formed, entirely fictitious ratio - it reads
           the hover ink against the RESTING background. That is not
           hypothetical: it is exactly what the CSSOM longhand enumeration did
           here before the cssText parse replaced it. So a rule that DECLARES a
           background must be observed to carry one inline afterwards. */
        const declaresBg = r.decls.some(
          (d) => d[0] === 'background' || d[0] === 'background-color');
        if (declaresBg) {
          declaredBg++;
          if (el.style.getPropertyValue('background') ||
              el.style.getPropertyValue('background-color')) landedBg++;
          else droppedBg.push(r.sel);
        }
        const cellsBefore = cells.length;
        /* Scoped to the replayed element's own subtree. Most buttons put their
           label in a <span>, so measuring the element itself would miss the
           ink entirely - the same finding that shaped CONTRAST_PROBE.
           ICONS COUNT, and they are the reason this probe exists at all: the
           defect that motivated the section (.search-btn:hover) paints no text
           whatsoever - its ink is an <svg> stroked with currentColor - so a
           text-only sweep would have reported the very rule it was written for
           as having nothing to measure. Icon ink is scored against WCAG 1.4.11
           (non-text contrast, 3:1), not 1.4.3's 4.5:1, because that is the
           criterion that actually applies to a graphical control. */
        const nodes = [el].concat([].slice.call(el.querySelectorAll('*')));
        for (const n of nodes) {
          const tag = n.tagName.toLowerCase();
          const paintsText = [].slice.call(n.childNodes).some(
            (x) => x.nodeType === 3 && x.textContent.trim());
          const ncs = getComputedStyle(n);
          let kind = null, inkSrc = null;
          if (paintsText) { kind = 'text'; inkSrc = ncs.color; }
          else if (tag === 'svg') {
            const stroke = ncs.stroke, fill = ncs.fill;
            const useStroke = stroke && stroke !== 'none';
            const useFill = fill && fill !== 'none';
            if (useStroke || useFill) { kind = 'icon'; inkSrc = useStroke ? stroke : fill; }
          }
          if (!kind) continue;
          let o = 1;
          for (let a = n; a; a = a.parentElement) {
            const v = parseFloat(getComputedStyle(a).opacity);
            o *= isNaN(v) ? 1 : v;
          }
          if (o === 0) continue;
          let bg = surfaceOf(n);
          const fg = parse(inkSrc);
          if (!bg || !fg) continue;
          const ink = o >= 0.999 ? fg : {
            r: o * fg.r + (1 - o) * bg.r,
            g: o * fg.g + (1 - o) * bg.g,
            b: o * fg.b + (1 - o) * bg.b,
          };
          cells.push({
            rule: r.sel,
            kind: kind,
            tag: tag + (n.className && typeof n.className === 'string' &&
              n.className.trim() ? '.' + n.className.trim().split(/\\s+/)[0] : ''),
            o: o,
            r: ratio(fg, bg),
            rEff: ratio(ink, bg),
            fg: 'rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ')',
            bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
          });
        }
        /* THE CAUSE, asserted beside the consequence. A rule that repaints a
           NEUTRAL element with a SATURATED fill changes the surface its ink
           lands on, so it owns that ink - inherited colour was chosen against
           the neutral surface and has no relationship to the new one.
           Measuring the ratio catches this only in the states where the two
           happen to differ; naming the missing declaration catches it
           everywhere.
           THE REST->STATE SHAPE IS THE WHOLE POINT, and it is why this is not
           simply "the fill is an accent". Measured across all six states, six
           rules repaint with an accent variable and declare no ink -
           .editor-save-btn, .editor-exit-btn, .welcome-open-btn,
           .file-update-btn.reload, .app-update-btn.primary and
           .note-dialog-btn.primary - and every one of them is ALREADY a
           saturated button at rest (chroma 128-171), merely shifting to its
           hover shade. Their ink was chosen against the accent and is still
           correct over it, so demanding a redeclaration would be six false
           positives. Only a neutral resting surface orphans the ink.
           GATED ON THE ELEMENT ACTUALLY HAVING INK, and that is deliberately
           structural rather than an excusal list: .editor-splitter is exactly
           the neutral->saturated shape (chroma 0 -> 137) and carries neither
           text nor icon, so demanding a colour from it would be demanding a
           declaration with nothing to declare it for. Deriving the exemption
           from "produced no measurable cell" means a splitter that later gains
           a label stops being exempt by itself. */
        if (cells.length > cellsBefore) {
          const stateSurf = surfaceOf(el);
          chromaBands.push({ sel: r.sel, rest: chroma(restSurf),
            state: chroma(stateSurf) });
          if (chroma(restSurf) <= 40 && chroma(stateSurf) >= 40 &&
              !r.decls.some((d) => d[0] === 'color' || d[0] === 'stroke' ||
                d[0] === 'fill')) accentNoInk.push(r.sel);
        }
        if (saved === null) el.removeAttribute('style'); else el.setAttribute('style', saved);
        }
      }
      return JSON.stringify({
        collected: collected.length,
        collectedSels: collected.map((c) => c.sel),
        matched: matched,
        unmatched: unmatched, cells: cells, capped: capped,
        declaredBg: declaredBg, landedBg: landedBg, droppedBg: droppedBg,
        accentNoInk: accentNoInk, chromaBands: chromaBands,
      });
    })()`;

    /* THE INSTRUMENT'S OWN SELF-CHECK, and it exists because three of the
       hardenings above are INERT against today's stylesheet. Keeping
       :focus-within intact while stripping it, refusing to descend into an
       @media that does not apply, and lifting !important out of a value before
       setProperty will accept it all changed ZERO subjects when they landed.
       The comma split is the exception and IS live: two real rules here
       (.editor-splitter:hover, .editor-splitter.dragging and
       .mermaid-tpl-btn:hover, .mermaid-tpl-btn.active) pair a state part with a
       plain class part, and the old whole-selector strip replayed the class
       part as though it were a hover subject.
       This project's rule is that an unreachable guard is still a contract but
       must be restated where it CAN be falsified, so each one is exercised
       against a synthetic stylesheet injected into the real document and
       collected by the real walk. A copy of the parser would prove nothing
       about the parser that runs. */
    const HOVER_SELFCHECK_UP = `(() => {
      const s = document.createElement('style');
      s.id = '__sc_style';
      s.textContent = [
        '.__sc-a, .__sc-b:hover { color: rgb(1,2,3); background: rgb(4,5,6); }',
        '.__sc-c:focus-within { color: rgb(7,8,9); background: rgb(10,11,12); }',
        '@media print { .__sc-d:hover { color: rgb(13,14,15);' +
          ' background: rgb(16,17,18); } }',
        '.__sc-e:hover { color: rgb(19,20,21) !important;' +
          ' background: rgb(22,23,24) !important; }'
      ].join('\\n');
      document.head.appendChild(s);
      const host = document.createElement('div');
      host.id = '__sc_host';
      for (const c of ['__sc-a', '__sc-b', '__sc-c', '__sc-d', '__sc-e']) {
        const d = document.createElement('div');
        d.className = c;
        d.textContent = 'x';
        host.appendChild(d);
      }
      document.body.appendChild(host);
      return document.querySelectorAll('#__sc_host > div').length;
    })()`;
    const HOVER_SELFCHECK_DOWN = `(() => {
      for (const id of ['__sc_style', '__sc_host']) {
        const n = document.getElementById(id);
        if (n) n.remove();
      }
      return document.querySelectorAll('[class^="__sc-"]').length +
        (document.getElementById('__sc_style') ? 1 : 0);
    })()`;

    /* Cells are keyed by rule + the tag that painted them, disambiguated by
       occurrence: a rule like `.markdown-body tr:hover` legitimately paints
       several identical cells, and collapsing them by name would compare a
       scheme's first cell against the default's second. */
    const hoverPaths = (got) => {
      const seen = new Map(), out = [];
      for (const c of got.cells) {
        const base = `${c.rule} > ${c.tag}`;
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        out.push(Object.assign({ path: n === 1 ? base : `${base}#${n}` }, c));
      }
      return out;
    };
    /* WCAG applies two DIFFERENT minima and this section respects both rather
       than picking the stricter one and calling it rigour: 1.4.3 asks 4.5:1 of
       text, 1.4.11 asks 3:1 of the graphical parts of a control. Holding icons
       to 4.5 would happen to pass today and would reject a future scheme for
       missing a bar the standard never set. */
    const HOVER_MIN = { text: 4.5, icon: 3 };
    const hoverBase = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (hover baseline)");
      hoverBase[mode] = JSON.parse(await exec(HOVER_PROBE));
    }

    /* Every selector here was verified by reading its consumer: each names a
       surface that genuinely does not exist in a resting document, so a replay
       has nothing to write onto. The list is asserted in BOTH directions - an
       unexcused miss fails, and an excusal that has stopped being needed fails
       too, so the map cannot quietly become a licence to lose coverage. */
    const HOVER_EXCUSALS = {
      ".notes-item:hover": "the notes panel renders one item per note; the census document carries none",
      ".mermaid-maximize-btn:hover": "injected into a rendered mermaid diagram, and the fixture has no diagram",
      ".code-copy-btn.copied:hover": "the .copied class exists only for the ~2s after a copy click",
      ".context-menu-item.disabled:hover": "the .disabled variant is applied only while an action is unavailable",
      ".note-tooltip-close:hover": "the tooltip is built on demand when a note marker is hovered",
      ".tools-menu-recent-item:hover": "the recent-files list is empty in the suite's isolated userData profile",
      ".tab:hover": "the tab strip renders only for open documents; this suite opens none",
      ".tab-close:hover": "same - no tab exists to carry a close button",
      "body.dark-mode .tab-close:hover": "same - no tab exists to carry a close button",
    };
    /* RUN IN BOTH MODES, and that is not symmetry for its own sake. A
       mode-scoped selector cannot be falsified from the wrong side: in light,
       body.dark-mode .tab-close misses because the BODY is not dark, so its
       excusal ("no tab exists to carry a close button") stays green forever
       even if a tab strip returns. Checking dark too means the excusal is
       tested against the absence it actually names. */
    {
      const planted = Number(await exec(HOVER_SELFCHECK_UP));
      const sc = JSON.parse(await exec(HOVER_PROBE));
      const left = Number(await exec(HOVER_SELFCHECK_DOWN));
      const has = (s) => sc.collectedSels.indexOf(s) !== -1;
      check(
        "hover replay self-check: the synthetic stylesheet was really installed and removed",
        planted === 5 && left === 0,
        `planted ${planted} elements, ${left} left behind`,
      );
      check(
        "hover replay self-check: a selector list contributes only the parts that carry a state",
        has(".__sc-b:hover") && !has(".__sc-a") && !has(".__sc-a, .__sc-b:hover"),
        `collected ${JSON.stringify(sc.collectedSels.filter((s) => s.indexOf("__sc") !== -1))}`,
      );
      check(
        "hover replay self-check: :focus-within is collected and strips to a valid bare selector",
        has(".__sc-c:focus-within") &&
          sc.unmatched.indexOf(".__sc-c:focus-within") === -1,
        `collected=${has(".__sc-c:focus-within")}, unmatched=${sc.unmatched.indexOf(".__sc-c:focus-within") !== -1}`,
      );
      check(
        "hover replay self-check: a rule inside a non-matching @media contributes nothing",
        !has(".__sc-d:hover"),
        "an @media print hover rule reached the on-screen subject set",
      );
      check(
        "hover replay self-check: a value carrying !important still lands on the probe element",
        has(".__sc-e:hover") && sc.droppedBg.indexOf(".__sc-e:hover") === -1,
        `collected=${has(".__sc-e:hover")}, droppedBg=${JSON.stringify(sc.droppedBg)}`,
      );
    }
    for (const mode of ["light", "dark"]) {
      const got = hoverBase[mode];
      console.log(
        `  note  hover replay (${mode}): collected ${got.collected}, ` +
          `matched ${got.matched}, cells ${got.cells.length}`,
      );
      check(
        `hover replay (${mode}): enough rules were collected, matched and measured`,
        got.collected >= 30 && got.matched >= 24 && got.cells.length >= 90,
        `collected ${got.collected}, matched ${got.matched}, cells ${got.cells.length}`,
      );
      const unexcused = got.unmatched.filter((s) => !HOVER_EXCUSALS[s]);
      check(
        `hover replay (${mode}): every rule the probe could not reach is a named, still-absent surface`,
        unexcused.length === 0,
        unexcused.join(" | "),
      );
      check(
        `hover replay (${mode}): no rule matched more elements than the probe measured`,
        got.capped.length === 0,
        `capped at ${got.capped.join(" | ")}`,
      );
      const stale = Object.keys(HOVER_EXCUSALS).filter(
        (s) => got.unmatched.indexOf(s) === -1,
      );
      check(
        `hover replay (${mode}): no excusal has outlived the absence it describes`,
        stale.length === 0,
        stale.join(" | "),
      );
    }

    /* THE POSITIVE CONTROL FOR THE INSTRUMENT, and it is not decorative: the
       first version of this probe read declarations off rule.style, which
       serialises a var()-bearing SHORTHAND as empty longhands. Every
       `background: var(--primary-color)` was silently dropped, so the accent
       rules this section exists to check were measured with the accent ink on
       the element's RESTING fill - .btn:hover reported a fully-formed,
       entirely fictitious 1.23:1. A dropped fill is indistinguishable from a
       real failure, which is exactly why it needs its own named assertion. */
    let bgDeclared = 0, bgLanded = 0;
    const bgDropped = [];
    const accentNoInk = new Set();
    const chromaSeen = [];
    const noteState = (got) => {
      bgDeclared += got.declaredBg;
      bgLanded += got.landedBg;
      for (const s of got.droppedBg) bgDropped.push(s);
      for (const s of got.accentNoInk) accentNoInk.add(s);
      for (const b of got.chromaBands) chromaSeen.push(b);
    };
    noteState(hoverBase.light);
    noteState(hoverBase.dark);

    for (const mode of ["light", "dark"]) {
      const worst = hoverPaths(hoverBase[mode])
        .slice()
        .sort((a, b) => a.rEff - b.rEff)
        .slice(0, 6)
        .map((c) => `${c.path} ${c.rEff.toFixed(2)}`);
      console.log(`  note  ${mode} default worst hover cells: ${worst.join(", ")}`);
    }

    /* THE DEFAULTS' HOVER CELLS ARE ASSERTED, NOT MERELY RECORDED, and this is
       the guard the section spent its first draft without. Every bar below is
       RELATIVE to a default measured in the same run, so a change that moved a
       default hover rule moved the yardstick with it and the whole section
       reported a clean sweep. That is not a hypothetical: adding
       --welcome-readme-ink-hover to :root instead of body repainted the DARK
       default's hover ink from #3bbfcc to #279EA7 - a plain violation of the
       byte-exactness requirement - and every one of these assertions passed.
       IT IS COMPARED AGAINST HEAD RATHER THAN AGAINST A STORED FIXTURE. A
       golden file records what the defaults looked like on the day someone
       remembered to regenerate it, and its provenance decays silently from
       then on; HEAD is the thing the requirement actually names. So both
       stylesheet generations are measured IN THE SAME RUN, through the same
       instrument, on the same DOM - the only difference between the two halves
       is which bytes the engine parsed. */
    const gitShow = (rel) =>
      require("child_process")
        .execFileSync("git", ["show", "HEAD:" + rel], {
          cwd: path.join(__dirname, ".."),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });
    const headSheets = {
      "styles.css": gitShow("src/styles.css"),
      "custom-styles.css": gitShow("src/custom-styles.css"),
    };
    /* MEASURED THROUGH THE REAL CASCADE, NOT THROUGH THE REPLAY, and the
       difference is the whole reason this assertion needed a second
       instrument. The replay above writes ONE rule's declarations onto an
       element, which is the right tool for asking "does this rule set its own
       ink" but the wrong one for asking "does this element still look the
       same": HEAD spells the dark chrome as a base rule PLUS a
       `body.dark-mode` override, while the working tree folds both into one
       tokenised rule. Replaying the base rule alone reproduces a state the
       product never renders, so the first version of this check reported
       .nav-btn's backdrop moving and body.dark-mode .search-btn:hover going
       "gone" - three findings that were all artifacts of rules being
       reorganised, with no pixel behind any of them.
       So the state pseudo-classes are rewritten into real CLASSES - identical
       specificity, so every rule keeps its exact weight and order - and the
       ENGINE resolves the cascade. Cells are keyed by DOM POSITION rather than
       by rule, because the rule that paints an element is exactly the thing
       this change is allowed to alter; the pixel is not. */
    const toClasses = (css) =>
      css
        .replace(/:focus-visible/g, ".__st_fv")
        .replace(/:focus(?!-)/g, ".__st_foc")
        .replace(/:hover/g, ".__st_hov")
        .replace(/:active/g, ".__st_act");
    const genSheets = {
      head: {
        "styles.css": toClasses(headSheets["styles.css"]),
        "custom-styles.css": toClasses(headSheets["custom-styles.css"]),
      },
      tree: {
        "styles.css": toClasses(
          fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8")),
        "custom-styles.css": toClasses(
          fs.readFileSync(path.join(__dirname, "..", "src", "custom-styles.css"), "utf8")),
      },
    };
    const installGen = (texts) => `(() => {
      for (const s of Array.prototype.slice.call(
        document.querySelectorAll('style[data-head-swap]'))) s.remove();
      const links = Array.prototype.slice.call(
        document.querySelectorAll('link[rel="stylesheet"]'));
      const texts = ${JSON.stringify(texts)};
      let n = 0;
      for (const l of links) {
        const t = texts[l.getAttribute('href')];
        if (t === undefined) continue;
        const s = document.createElement('style');
        s.setAttribute('data-head-swap', l.getAttribute('href'));
        s.textContent = t;
        l.parentNode.insertBefore(s, l);
        l.disabled = true;
        n++;
      }
      /* TRANSITIONS ARE PINNED OFF FOR THE WHOLE MEASUREMENT, and without this
         the comparison is very nearly vacuous. Adding the state class starts
         the very transition the rule declares, and a computed colour read while
         a transition is running is the PREVIOUS state's colour - so every
         transitioned property reported its RESTING value in both halves and
         agreed perfectly. Measured: with this missing, the dark default's
         READ ME button reported rgb(59,191,204) on rgb(26,26,26) - its resting
         ink on the page - in both generations, while the hover rule it was
         supposed to be exercising painted an accent tint the probe never saw.
         Same trap recorded at settleTransitions(); here the probe's own class
         flip is what starts the clock. */
      if (!document.getElementById('__st_notrans')) {
        const k = document.createElement('style');
        k.id = '__st_notrans';
        k.textContent = '*, *::before, *::after { transition: none !important;' +
          ' animation: none !important; }';
        document.head.appendChild(k);
      }
      return n;
    })()`;
    /* One element is put into the state at a time. Flipping every hoverable
       element at once would repaint a menu item AND the panel behind it, which
       is a picture the product never draws and would compare two fictions
       rather than two realities. */
    const CASCADE_HELPERS = `
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function over(fg, bg) {
        return {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        };
      }
      function surfaceOf(el) {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
        }
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      }
      const rnd = (c) => 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) +
        ',' + Math.round(c.b) + ')';
      function pathOf(el) {
        const p = [];
        for (let n = el; n && n !== document.body && n.parentElement; n = n.parentElement) {
          p.push(Array.prototype.indexOf.call(n.parentElement.children, n));
        }
        return p.reverse().join('/');
      }
      const CLASSES = ['__st_hov', '__st_fv', '__st_foc', '__st_act'];
    `;
    /* The bare selectors are gathered from whichever generation is installed;
       the caller takes the UNION of the two, so a rule present in only one of
       them still puts its element into the state in both. Otherwise a deleted
       rule would simply stop being measured - and a deletion that changes the
       picture is precisely what this exists to catch. */
    const COLLECT_STATE_SELECTORS = `(() => {
      ${CASCADE_HELPERS}
      const found = {};
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.style && rule.selectorText) {
            for (const cls of CLASSES) {
              if (rule.selectorText.indexOf('.' + cls) === -1) continue;
              if (rule.selectorText.indexOf('::') !== -1) continue;
              const bare = rule.selectorText.split(',').map(
                (s) => s.split('.' + cls).join('').trim()).filter(Boolean);
              for (const b of bare) (found[cls] = found[cls] || []).push(b);
            }
          }
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (rules) walk(rules);
      }
      for (const k of Object.keys(found)) found[k] = [...new Set(found[k])];
      return JSON.stringify(found);
    })()`;
    /* One element is put into the state at a time. Flipping every hoverable
       element at once would repaint a menu item AND the panel behind it, a
       picture the product never draws - that would compare two fictions
       rather than two realities. */
    const measureStates = (plan) => `(() => {
      ${CASCADE_HELPERS}
      const plan = ${JSON.stringify(plan)};
      const out = {};
      const labels = {};
      let elements = 0;
      const nameOf = (n) => n.tagName.toLowerCase() +
        (n.className && typeof n.className === 'string' && n.className.trim()
          ? '.' + n.className.trim().split(/\\s+/).join('.') : '') +
        (n.id ? '#' + n.id : '');
      for (const cls of Object.keys(plan)) {
        for (const sel of plan[cls]) {
          let els = [];
          try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); }
          catch (e) { continue; }
          for (const el of els.slice(0, 8)) {
            el.classList.add(cls);
            elements++;
            const nodes = [el].concat(
              Array.prototype.slice.call(el.querySelectorAll('*')));
            for (const n of nodes) {
              const tag = n.tagName.toLowerCase();
              const paintsText = Array.prototype.slice.call(n.childNodes).some(
                (x) => x.nodeType === 3 && x.textContent.trim());
              const ncs = getComputedStyle(n);
              let kind = null, inkSrc = null;
              if (paintsText) { kind = 'text'; inkSrc = ncs.color; }
              else if (tag === 'svg') {
                const useStroke = ncs.stroke && ncs.stroke !== 'none';
                const useFill = ncs.fill && ncs.fill !== 'none';
                if (useStroke || useFill) {
                  kind = 'icon'; inkSrc = useStroke ? ncs.stroke : ncs.fill;
                }
              }
              if (!kind) continue;
              const fg = parse(inkSrc);
              if (!fg) continue;
              out[cls + '@' + pathOf(el) + '>' + pathOf(n) + ':' + kind] =
                rnd(fg) + ' on ' + rnd(surfaceOf(n));
              labels[cls + '@' + pathOf(el) + '>' + pathOf(n) + ':' + kind] =
                cls.replace('__st_', ':') + ' ' + nameOf(el) +
                (n === el ? '' : ' > ' + nameOf(n)) +
                (n.textContent ? ' "' + n.textContent.trim().slice(0, 24) + '"' : '');
            }
            el.classList.remove(cls);
          }
        }
      }
      return JSON.stringify({ cells: out, labels: labels, elements: elements });
    })()`;
    const removeHead = `(() => {
      for (const s of Array.prototype.slice.call(
        document.querySelectorAll('style[data-head-swap]'))) s.remove();
      const k = document.getElementById('__st_notrans');
      if (k) k.remove();
      for (const l of Array.prototype.slice.call(
        document.querySelectorAll('link[rel="stylesheet"]'))) l.disabled = false;
      return document.querySelectorAll('style[data-head-swap]').length +
        (document.getElementById('__st_notrans') ? 1 : 0);
    })()`;

    const gen = {};
    let installedCount = 0;
    for (const which of ["tree", "head"]) {
      installedCount = await exec(installGen(genSheets[which]));
      const sels = JSON.parse(await exec(COLLECT_STATE_SELECTORS));
      gen[which] = { sels: sels, byMode: {} };
    }
    // The union, so a rule that exists in only one generation still puts its
    // element into the state in BOTH halves of the comparison.
    const plan = {};
    for (const which of ["tree", "head"]) {
      for (const [cls, list] of Object.entries(gen[which].sels)) {
        plan[cls] = [...new Set((plan[cls] || []).concat(list))];
      }
    }
    for (const which of ["tree", "head"]) {
      await exec(installGen(genSheets[which]));
      for (const mode of ["light", "dark"]) {
        await applySettled(mode, null, `${mode} default (${which} stylesheets)`);
        gen[which].byMode[mode] = JSON.parse(await exec(measureStates(plan)));
      }
    }
    const leftOver = await exec(removeHead);
    await applySettled("light", null, "restore working-tree stylesheets");

    check(
      "both stylesheet generations really were installed and then removed again",
      installedCount === 2 && leftOver === 0,
      `installed ${installedCount} sheets, ${leftOver} left behind`,
    );
    const planned = Object.values(plan).reduce((n, l) => n + l.length, 0);
    const drift = [];
    let compared = 0;
    for (const mode of ["light", "dark"]) {
      const now = gen.tree.byMode[mode].cells;
      const was = gen.head.byMode[mode].cells;
      const lab = (k) =>
        gen.head.byMode[mode].labels[k] || gen.tree.byMode[mode].labels[k] || k;
      for (const [k, v] of Object.entries(was)) {
        if (!(k in now)) { drift.push(`${mode} ${lab(k)}: gone`); continue; }
        compared++;
        if (now[k] !== v) drift.push(`${mode} ${lab(k)}: ${v} -> ${now[k]}`);
      }
      for (const k of Object.keys(now)) {
        if (!(k in was)) drift.push(`${mode} ${lab(k)}: new`);
      }
    }
    console.log(
      `  note  cascade comparison: ${planned} state selectors, ` +
        `${gen.tree.byMode.light.elements} elements put into state, ` +
        `${compared} cells compared`,
    );
    /* THE ONE THING THE SWAP CANNOT HOLD STILL. Only the CSS is exchanged; the
       DOM is built by JavaScript, which the swap leaves at the working tree's
       version. So chrome this change ADDS is present in both halves, and in
       the HEAD half it renders with whatever it inherits rather than with the
       rule that was written for it - a difference with no pixel behind it,
       because at HEAD the element did not exist at all. A surface that is new
       has no frozen baseline to be measured against. The exemption is named
       and its continued necessity is asserted, so it cannot quietly widen into
       a licence for the chrome around it. */
    const DEFAULT_DRIFT_EXCUSALS = {
      "theme-scheme-group":
        "the 'Light schemes' and 'Dark schemes' group headings are chrome this change introduces; HEAD has no rule for them, so the HEAD half measures the menu's inherited ink and the tree half the muted heading colour they were given",
    };
    const driftExcusalUsed = new Set();
    const realDrift = drift.filter((d) => {
      for (const k of Object.keys(DEFAULT_DRIFT_EXCUSALS)) {
        if (d.includes(k)) { driftExcusalUsed.add(k); return false; }
      }
      return true;
    });
    check(
      "neither frozen default has changed a single state colour since HEAD",
      planned >= 30 && compared >= 200 && realDrift.length === 0,
      `${planned} state selectors planned, ${compared} cells compared against HEAD; ` +
        realDrift.slice(0, 12).join(" | ") +
        (realDrift.length > 12 ? ` (+${realDrift.length - 12} more)` : ""),
    );
    const staleDriftExcusals = Object.keys(DEFAULT_DRIFT_EXCUSALS).filter(
      (k) => !driftExcusalUsed.has(k),
    );
    check(
      "every default-drift excusal still names chrome that HEAD really lacks",
      staleDriftExcusals.length === 0,
      `no longer drifting, so the entries must go: ${staleDriftExcusals.join(", ")}`,
    );

    for (const [mode, scheme] of SCHEME_STATES) {
      await applySettled(mode, scheme, scheme + " (hover)");
      const got = JSON.parse(await exec(HOVER_PROBE));
      noteState(got);
      const base = new Map(hoverPaths(hoverBase[mode]).map((c) => [c.path, c]));
      const cells = hoverPaths(got);

      const undimmed = cells.filter((c) => c.o >= 0.999);
      const shortfall = undimmed.filter((c) => c.rEff < HOVER_MIN[c.kind] - 0.005);
      check(
        `${scheme}: every hover cell it paints at full opacity meets its WCAG minimum`,
        undimmed.length >= 12 && shortfall.length === 0,
        `${undimmed.length} full-opacity cells; ` +
          shortfall
            .map((c) => `${c.path} ${c.rEff.toFixed(2)} < ${HOVER_MIN[c.kind]} (${c.fg} on ${c.bg})`)
            .join(" | "),
      );

      /* The two relative bars partition the cells by what the DEFAULT already
         achieved, so every cell is covered by exactly one of them and neither
         can be satisfied by the other's population. They exist because the
         absolute bar above is blind on both flanks: it cannot see a cell
         falling 8.0 -> 4.6, and it says nothing at all about the dimmed cells
         a scheme cannot reach without tokenising their opacity. */
      const kept = [], worsened = [];
      const paired = cells.filter((c) => base.has(c.path));
      for (const c of cells) {
        const b = base.get(c.path);
        if (!b) continue;
        const min = HOVER_MIN[c.kind];
        if (b.rEff >= min) { if (c.rEff < min - 0.005) kept.push([c, b]); }
        else if (c.rEff < b.rEff - 0.01) worsened.push([c, b]);
      }
      check(
        `${scheme}: every hover cell that met its minimum in the default still meets it`,
        paired.length >= 25 &&
          kept.length === 0,
        `${paired.length} of ${cells.length} scheme cells paired against ${base.size} default cells; ` +
          kept.map(([c, b]) => `${c.path} ${b.rEff.toFixed(2)} -> ${c.rEff.toFixed(2)}`).join(" | "),
      );
      check(
        `${scheme}: no hover cell that was already below its minimum in the default is made worse`,
        paired.length >= 25 && worsened.length === 0,
        worsened.map(([c, b]) => `${c.path} ${b.rEff.toFixed(2)} -> ${c.rEff.toFixed(2)}`).join(" | "),
      );
    }

    check(
      "hover replay: every rule that declares a background really carried one into the measurement",
      bgDeclared >= 100 && bgDropped.length === 0 && bgLanded === bgDeclared,
      `${bgLanded}/${bgDeclared} landed; dropped: ${bgDropped.join(" | ")}`,
    );
    check(
      "every hover rule that repaints a neutral element with a saturated fill sets its own ink",
      accentNoInk.size === 0,
      [...accentNoInk].join(" | "),
    );
    /* THE POSITIVE CONTROL FOR THE CLASSIFIER ABOVE. Splitting "neutral" from
       "saturated" at a chroma of 40 is only meaningful while nothing the
       product paints sits near 40, and that is a property of the palette, not
       a law - a future scheme with a muted accent would put the split inside
       its own data and the gate would start guessing. Measured across all six
       states the two clusters are 0-33 and 90-209, so the threshold has ~56
       units of clearance on each side. Asserting the GAP rather than the
       threshold means such a scheme fails loudly here, pointing at the
       classifier, instead of silently mis-sorting one rule somewhere else. */
    const ambiguous = chromaSeen.filter(
      (b) => (b.rest >= 34 && b.rest <= 89) || (b.state >= 34 && b.state <= 89),
    );
    check(
      "neutral and saturated fills stay far enough apart for the classifier to tell them apart",
      chromaSeen.length >= 100 && ambiguous.length === 0,
      `${chromaSeen.length} fills measured; ambiguous: ` +
        ambiguous.map((b) => `${b.sel} rest=${b.rest} state=${b.state}`).join(" | "),
    );
    await applySettled("light", null, "restore after hover probe");

    // ── 10h: the glyphs no element sweep can see ────────────────────────────
    // 10d walks document.querySelectorAll('*'), so its subject set is elements.
    // A ::before or ::after that carries `content` paints TEXT and has its own
    // colour, its own background and its own opacity - and it is not an
    // element, so it is invisible to that walk. 10g does not cover it either:
    // its collector explicitly SKIPS any selector containing '::', because a
    // pseudo-element cannot be selected and therefore cannot be replayed onto.
    // So the product's four glyph-painting pseudo rules - the two submenu
    // ticks, the drag-drop overlay label and the heading collapse arrow - sat
    // outside every contrast assertion in the suite.
    //
    // THE SUBJECT SET IS BUILT TWICE, FROM TWO INDEPENDENT DIRECTIONS, and
    // that is the whole design. The MEASUREMENT sweeps the live DOM, so a
    // pseudo painted by a rule nobody thought to look for is still scored. The
    // COVERAGE check sweeps the STYLESHEET, so a rule whose subject is absent
    // from the DOM - the failure mode R295 recorded, where an assertion walks
    // a document that no longer contains the thing it is named for - is
    // reported rather than silently dropping out of a clean sweep.
    const PSEUDO_PROBE = `(() => {
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function lum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      }
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      function over(fg, bg) {
        return {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        };
      }
      function composite(stack) {
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      }
      /* THE PSEUDO'S OWN FILL IS THE FIRST LAYER, NOT A SEPARATE CASE. The
         drag-drop overlay paints its label on an accent tint at alpha 0.08 that
         belongs to the ::after itself; taking the ELEMENT's background as the
         surface would score that label against the bare page and report a
         ratio the reader never receives. Same compositing rule as 10g, applied
         one layer earlier. */
      function surfaceUnder(el, own) {
        const stack = [];
        if (own && own.a > 0) {
          stack.push(own);
          if (own.a >= 0.999) return composite(stack);
        }
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
        }
        return composite(stack);
      }
      /* WHAT COUNTS AS A GLYPH IS DECIDED BY THE VALUE, NOT BY THE RULE'S
         INTENT. content: "" is the product's own alignment spacer and paints
         nothing; content: url(...) paints an image, which has no text colour to
         score. Only a non-empty quoted string, or a value pulled from the
         document through attr()/counter(), puts ink on the screen. The same
         predicate is used on the COMPUTED value below and on the AUTHORED
         value in the coverage scan, so the two directions cannot disagree
         about what they are counting. */
      const GLYPH = (v) => {
        if (!v) return false;
        const s = String(v).trim();
        if (!s || s === 'none' || s === 'normal') return false;
        const q = s.match(/"[^"]*"|'[^']*'/g);
        if (q && q.join('').replace(/["']/g, '').trim()) return true;
        return /(^|[^-\\w])(attr|counter|counters)\\(/.test(s);
      };
      /* The overlay is put into the state the reader sees, by doing exactly
         what the product does at renderer.js:2138-2139 - the label comes from
         the product's own string table, never from a literal here, because a
         fabricated label would measure a surface the product might never
         paint. Restored before the probe returns, so every one of the six
         theme states scans an identical document and the equality guard below
         means something. */
      const hadDrop = document.body.classList.contains('drop-active');
      if (!hadDrop) {
        if (!document.body.dataset.dropLabel && typeof i18n === 'function') {
          try { document.body.dataset.dropLabel = i18n('drop.hint'); } catch (e) {}
        }
        document.body.classList.add('drop-active');
      }
      const cells = [];
      const seen = new Set();
      let scanned = 0, glyphs = 0, invisible = 0;
      const els = [document.body].concat([].slice.call(document.querySelectorAll('*')));
      for (const el of els) {
        scanned++;
        for (const pseudo of ['::before', '::after']) {
          const cs = getComputedStyle(el, pseudo);
          if (!cs || !GLYPH(cs.content)) continue;
          if (cs.display === 'none') continue;
          glyphs++;
          let o = parseFloat(cs.opacity);
          if (isNaN(o)) o = 1;
          for (let a = el; a; a = a.parentElement) {
            const v = parseFloat(getComputedStyle(a).opacity);
            o *= isNaN(v) ? 1 : v;
          }
          if (o === 0) { invisible++; continue; }
          const fg = parse(cs.color);
          const bg = surfaceUnder(el, parse(cs.backgroundColor));
          if (!fg || !bg) continue;
          /* WHETHER THE PSEUDO CHOOSES ITS OWN INK IS MEASURED, NOT LISTED,
             and it is what decides which bars can meaningfully apply to it.
             The heading collapse arrow declares no colour at all: it inherits
             the heading's, so the only lever a scheme has over it is the
             heading colour - which 10d already holds to an absolute 4.5 as a
             full-opacity text cell. Its 0.4 opacity is frozen with the
             defaults, so its RENDERED ratio is ~2.2 whatever a scheme does,
             and demanding that ratio never drift by 0.1 would forbid
             legitimate palette choices while protecting nothing. The two
             ticks and the overlay label DO declare their own colour, so they
             keep a lever of their own and stay in every bar. */
          const hostFg = getComputedStyle(el).color;
          const ownInk = cs.color !== hostFg;
          const hostPaintsText = [].slice.call(el.childNodes)
            .some((n) => n.nodeType === 3 && n.textContent.trim());
          let path = '', node = el;
          while (node && node.nodeType === 1) {
            const parent = node.parentElement;
            const idx = parent ? [].indexOf.call(parent.children, node) + 1 : 1;
            path = '>' + node.tagName.toLowerCase() + ':' + idx + path;
            node = parent;
          }
          path += pseudo;
          if (seen.has(path)) continue;
          seen.add(path);
          const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\\s+/).join('.') : '') + pseudo;
          const ink = o >= 0.999 ? fg : {
            r: o * fg.r + (1 - o) * bg.r,
            g: o * fg.g + (1 - o) * bg.g,
            b: o * fg.b + (1 - o) * bg.b,
          };
          cells.push({
            path: path, sel: sel, o: o, r: ratio(fg, bg), rEff: ratio(ink, bg),
            ownInk: ownInk, hostPaintsText: hostPaintsText,
            fg: 'rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ')',
            bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
          });
        }
      }
      /* THE COVERAGE HALF: every glyph-painting rule the stylesheet declares
         must have produced a measured cell. An assertion of absence over a
         swept DOM is only as wide as that DOM, so without this a rule whose
         subject is never built would leave the subject set with nothing
         failing anywhere. */
      const PSEUDO_SEL = /::?(before|after)\\b/;
      const PSEUDO_SEL_G = /::?(before|after)\\b/g;
      const glyphRules = [];
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.style && rule.selectorText && PSEUDO_SEL.test(rule.selectorText) &&
              GLYPH(rule.style.getPropertyValue('content'))) {
            for (const part of rule.selectorText.split(',')) {
              const t = part.trim();
              if (t && PSEUDO_SEL.test(t)) {
                const which = /::?after\\b/.test(t) ? '::after' : '::before';
                glyphRules.push({ sel: t, bare: t.replace(PSEUDO_SEL_G, '').trim(), pseudo: which });
              }
            }
          }
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (rules) walk(rules);
      }
      const uncovered = [];
      for (const g of glyphRules) {
        let hit = false;
        try {
          for (const el of document.querySelectorAll(g.bare)) {
            const cs = getComputedStyle(el, g.pseudo);
            if (cs && GLYPH(cs.content) && cs.display !== 'none') { hit = true; break; }
          }
        } catch (e) { hit = false; }
        if (!hit && uncovered.indexOf(g.sel) === -1) uncovered.push(g.sel);
      }
      if (!hadDrop) document.body.classList.remove('drop-active');
      /* The bare page, composited the same way and with NO pseudo fill on top.
         It is what the overlay label's surface would collapse to if the
         pseudo's own background ever stopped being the first layer, which is
         the one part of surfaceUnder() no value comparison can see. */
      const pb = surfaceUnder(document.body, null);
      return JSON.stringify({
        scanned: scanned, glyphs: glyphs, invisible: invisible,
        rules: glyphRules.map((g) => g.sel), uncovered: uncovered,
        dropLabel: document.body.dataset.dropLabel || '',
        pageBg: 'rgb(' + Math.round(pb.r) + ',' + Math.round(pb.g) + ',' + Math.round(pb.b) + ')',
        cells: cells,
      });
    })()`;

    const pseudoBase = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (pseudo baseline)");
      pseudoBase[mode] = JSON.parse(await exec(PSEUDO_PROBE));
    }
    const pBuckets = (s) => ({
      glyphs: s.glyphs,
      invisible: s.invisible,
      cells: s.cells.length,
      dimmed: s.cells.filter((c) => c.o < 0.999).length,
      undimmed: s.cells.filter((c) => c.o >= 0.999).length,
    });
    /* THE FLOOR IS ON THE PRODUCT'S RULES, NOT ON THE CELL COUNT, because the
       cell count is dominated by the heading arrows and would stay comfortably
       above any threshold while every hand-written rule in custom-styles.css
       quietly stopped matching. Measured: 4 glyph rules (two ticks, the
       drop-overlay label, the heading arrow written as one six-part list). */
    check(
      "the pseudo-element sweep found the product's glyph-painting rules",
      pseudoBase.light.rules.length >= 4 && pseudoBase.dark.rules.length >= 4,
      `light ${pseudoBase.light.rules.length}, dark ${pseudoBase.dark.rules.length} rule(s): ${pseudoBase.light.rules.join(" | ")}`,
    );
    check(
      "every glyph-painting rule in the stylesheet reached a measured element",
      pseudoBase.light.uncovered.length === 0 && pseudoBase.dark.uncovered.length === 0,
      `unreached (so any contrast defect in them goes unreported): light [${pseudoBase.light.uncovered.join(" | ")}] dark [${pseudoBase.dark.uncovered.join(" | ")}]`,
    );
    /* POSITIVE CONTROL FOR THE OVERLAY ACTIVATION. body.drop-active::after is
       the one glyph surface no resting DOM contains, so the probe puts the
       body into that state itself. If the class or the label ever stops being
       what the product uses, the overlay simply produces no cell and the
       accent-on-tint pairing leaves the subject set with every assertion still
       green - the R295 failure exactly. */
    const dropCell = (s) => s.cells.some((c) => c.sel.indexOf("body") === 0 && c.sel.indexOf("::after") !== -1);
    check(
      "the drag-drop overlay label was really put into the state the reader sees",
      dropCell(pseudoBase.light) && dropCell(pseudoBase.dark) && pseudoBase.light.dropLabel !== "",
      `label=${JSON.stringify(pseudoBase.light.dropLabel)} light=${dropCell(pseudoBase.light)} dark=${dropCell(pseudoBase.dark)}`,
    );
    /* THE SECOND HALF OF THAT CONTROL, and it needs its own name because it
       fails under a different accident. The label is painted on a fill that
       belongs to the ::after, not to any element - an 8% tint of the accent
       over the page - so taking the ELEMENT's background as the surface would
       score it against the bare page and report a ratio the reader never
       receives. That mistake is invisible to every value comparison here: it
       does not strand a colour or drop a cell, it just measures the wrong
       pair, and it measures it in the flattering direction. Both defaults'
       labels read ~3.2 against the bare page and ~3.0 against their own tint,
       so the ONLY thing that can catch it is the surface itself. */
    const dropSurface = (s) => {
      const c = s.cells.find((x) => x.sel.indexOf("body") === 0 && x.sel.indexOf("::after") !== -1);
      return c ? c.bg : "";
    };
    check(
      "the overlay label was measured against its own tint, not the bare page beneath it",
      ["light", "dark"].every(
        (m) => dropSurface(pseudoBase[m]) && dropSurface(pseudoBase[m]) !== pseudoBase[m].pageBg,
      ),
      `light label-surface=${dropSurface(pseudoBase.light)} page=${pseudoBase.light.pageBg}; ` +
        `dark label-surface=${dropSurface(pseudoBase.dark)} page=${pseudoBase.dark.pageBg}`,
    );
    /* Both buckets occupied, for the same reason 10d asserts it: the bars
       below are SPLIT by this distinction, so an empty bucket makes one of
       them vacuous. The heading arrows are dimmed (opacity .4), the ticks and
       the overlay label are not. */
    check(
      "the defaults paint pseudo glyphs at BOTH full and reduced opacity",
      ["light", "dark"].every(
        (m) => pBuckets(pseudoBase[m]).dimmed > 0 && pBuckets(pseudoBase[m]).undimmed > 0,
      ),
      `light ${JSON.stringify(pBuckets(pseudoBase.light))}, dark ${JSON.stringify(pBuckets(pseudoBase.dark))}`,
    );
    /* RECORDED, NOT ASSERTED AWAY, exactly as 10d records the defaults' own
       sub-AA cells. The submenu tick is var(--primary-color) on the menu fill
       and the overlay label is the same accent on an 8% tint of itself; both
       are frozen by the byte-exact-default requirement, so the honest bar for
       them is the relative one below. A non-empty list is also what stops the
       relative bars being trivially true for every scheme. */
    check(
      "both defaults carry the pre-existing sub-AA pseudo cells the relative bars are measured against",
      ["light", "dark"].every((m) => pseudoBase[m].cells.filter((c) => c.rEff < 4.5).length > 0),
      `light ${pseudoBase.light.cells.filter((c) => c.rEff < 4.5).length}, dark ${pseudoBase.dark.cells.filter((c) => c.rEff < 4.5).length}`,
    );
    const pShow = (c) => `${c.sel} ${c.fg} on ${c.bg} o=${c.o.toFixed(2)} r=${c.r.toFixed(2)} rendered=${c.rEff.toFixed(2)}`;
    /* THE PAIRING KEY IS THE SELECTOR, NOT THE DOM PATH, and that is a real
       difference here rather than a stylistic one. 10d keys on the path because
       its population is 157 cells and a tag-name key would collapse dozens of
       them. This population is 8, and one of its members MOVES BY DESIGN: the
       submenu tick is drawn by .custom-scheme-option.active::before, so
       selecting a scheme relocates it to that scheme's row. Under a path key
       the tick read as two cells with no counterpart in the baseline, and the
       assertion written to catch a SHRINKING document instead reported the
       product working correctly. The selector carries .active, so it is stable
       across exactly the states the tick moves between. */
    const bySel = (s) => {
      const m = new Map();
      for (const c of s.cells) {
        const prev = m.get(c.sel);
        if (!prev || c.rEff < prev.rEff) m.set(c.sel, c);
      }
      return m;
    };
    /* THE EXEMPTION IS PROVEN, NOT DECLARED. An inherited-ink cell is only
       safely outside the relative bars if the ink it inherits is itself held
       to a bar somewhere - which is true exactly when the host element paints
       text of its own, because that is 10d's subject. The floor stops the
       exemption from quietly becoming the whole population. */
    for (const mode of ["light", "dark"]) {
      const inherited = pseudoBase[mode].cells.filter((c) => !c.ownInk);
      check(
        `${mode} default: every pseudo glyph that inherits its ink sits on an element 10d already scores`,
        inherited.length >= 3 && inherited.every((c) => c.hostPaintsText),
        `${inherited.length} inherited-ink cell(s); not text-painting: ${inherited.filter((c) => !c.hostPaintsText).map((c) => c.sel).join(" | ")}`,
      );
      check(
        `${mode} default: at least one pseudo glyph chooses its own ink, so the relative bars have a population`,
        pseudoBase[mode].cells.filter((c) => c.ownInk).length >= 2,
        `own-ink cells: ${pseudoBase[mode].cells.filter((c) => c.ownInk).map((c) => c.sel).join(" | ")}`,
      );
    }
    for (const [mode, scheme] of SCHEME_STATES) {
      await applySettled(mode, scheme, scheme + " (pseudo)");
      const cur = JSON.parse(await exec(PSEUDO_PROBE));
      const baseBySel = bySel(pseudoBase[mode]);
      check(
        `${scheme}: the pseudo sweep scanned the very same document its mode's default did`,
        JSON.stringify(pBuckets(cur)) === JSON.stringify(pBuckets(pseudoBase[mode])) &&
          cur.uncovered.length === 0 &&
          cur.cells.every((c) => baseBySel.has(c.sel)),
        `scheme ${JSON.stringify(pBuckets(cur))} vs default ${JSON.stringify(pBuckets(pseudoBase[mode]))}; uncovered [${cur.uncovered.join(" | ")}]; unpaired: ${cur.cells.filter((c) => !baseBySel.has(c.sel)).map((c) => c.sel).join(" | ")}`,
      );
      const pUndimmed = cur.cells.filter((c) => c.o >= 0.999 && c.rEff < 4.5);
      check(
        `${scheme}: every pseudo glyph it paints at full opacity meets WCAG AA (4.5:1)`,
        pUndimmed.length === 0,
        pUndimmed.map(pShow).join(" | "),
      );
      const pDimmed = cur.cells.filter((c) => c.o < 0.999 && c.r < 4.5);
      check(
        `${scheme}: every dimmed pseudo glyph's colour choice meets WCAG AA before the inherited dimming`,
        pDimmed.length === 0,
        pDimmed.map(pShow).join(" | "),
      );
      const pNovel = cur.cells.filter(
        (c) => c.ownInk && c.rEff < 4.5 && !(baseBySel.get(c.sel) && baseBySel.get(c.sel).rEff < 4.5),
      );
      check(
        `${scheme}: every pseudo glyph that RENDERS below AA also renders below AA in its mode's default`,
        pNovel.length === 0,
        pNovel
          .map((c) => `${pShow(c)} (default rendered ${baseBySel.get(c.sel) ? baseBySel.get(c.sel).rEff.toFixed(2) : "ABSENT"})`)
          .join(" | "),
      );
      const pWorse = cur.cells.filter(
        (c) =>
          c.ownInk &&
          baseBySel.has(c.sel) &&
          baseBySel.get(c.sel).rEff < 4.5 &&
          c.rEff < baseBySel.get(c.sel).rEff - 0.01,
      );
      check(
        `${scheme}: no pseudo glyph that was already below AA in the default is made worse`,
        pWorse.length === 0,
        pWorse
          .map((c) => `${c.sel} rendered ${baseBySel.get(c.sel).rEff.toFixed(2)} -> ${c.rEff.toFixed(2)}`)
          .join(" | "),
      );
    }
    console.log(
      `  note: pseudo glyph sweep: ${pseudoBase.light.rules.length} rules, ` +
        `${JSON.stringify(pBuckets(pseudoBase.light))} light / ${JSON.stringify(pBuckets(pseudoBase.dark))} dark`,
    );
    await applySettled("light", null, "restore after pseudo probe");

    // The welcome markup has served 10c, 10d, 10f and 10g; take it back out so
    // 10e and the final restore see the document the rest of the suite built.
    await exec(
      `(() => { const n = document.querySelector('[data-folia-welcome-probe]');
        if (n) n.remove(); return 1; })()`,
    );

    // ── 10e: behaviour - the registry's own rules ────────────────────────────
    // Everything above measures the STYLESHEET. These measure the JS that
    // decides which block applies, driven through window.foliaThemes rather
    // than a reimplementation of it.
    const beh = JSON.parse(
      await exec(`(() => {
        const T = window.foliaThemes, K = T.SCHEME_KEYS, out = {};
        const state = () => (document.body.getAttribute('data-theme') || 'none') + '/' +
          (document.body.classList.contains('dark-mode') ? 'dark' : 'light');

        // Picking a dark scheme from a light page must switch the MODE too -
        // that is what clicking it means to a reader.
        localStorage.setItem('themeMode', 'light');
        T.setScheme('abyss');
        out.crossMode = state();
        out.crossModePref = localStorage.getItem('themeMode');

        // A base scheme applies by REMOVING data-theme. Writing
        // data-theme="default-dark" instead would need a second copy of the
        // default appearance in the stylesheet, free to drift from the golden.
        T.setScheme('default-dark');
        out.baseApplies = state();

        // An unknown stored id - a downgrade, or a scheme withdrawn - falls
        // back to the mode's base rather than leaving the page half-applied.
        localStorage.setItem(K.dark, 'no-such-scheme-xyz');
        out.unknownFallback = T.schemeFor('dark').id;

        // A DARK id stored under the LIGHT key must not be applied over a light
        // page. This is the s.mode === mode term in schemeFor().
        localStorage.setItem(K.light, 'abyss');
        out.foreignModeFallback = T.schemeFor('light').id;
        localStorage.removeItem(K.light);
        localStorage.removeItem(K.dark);

        // An export owns the appearance until it has finished rasterising.
        localStorage.setItem('themeMode', 'dark');
        T.setScheme('ember');
        const before = state();
        beginExportThemeHold();
        parkExportScheme();
        out.parked = document.body.getAttribute('data-theme') || 'none';
        // While the hold is up, a scheme picked from the menu must NOT repaint
        // the page underneath printToPDF - and once the hold releases it must
        // land. A DIFFERENT scheme is picked on purpose: re-picking the one
        // already stored makes the release indistinguishable from restoring a
        // parked snapshot, and restoreExportScheme() reads the STORED
        // PREFERENCE (renderer.js:2300-2313 says so in as many words), which is
        // the only reason a mid-export menu pick lands at all.
        T.setScheme('abyss');
        out.heldNoOp = document.body.getAttribute('data-theme') || 'none';
        out.holdReportedUp = ${HELD}();
        endExportThemeHold();
        restoreExportScheme();
        out.restored = state();
        out.before = before;
        out.holdReportedDown = ${HELD}();
        return JSON.stringify(out);
      })()`),
    );
    check(
      "picking a scheme from the other mode switches the mode with it",
      beh.crossMode === "abyss/dark" && beh.crossModePref === "dark",
      `state=${beh.crossMode} themeMode=${beh.crossModePref}`,
    );
    check(
      "a base scheme applies by removing data-theme, not by declaring itself",
      beh.baseApplies === "none/dark",
      `state=${beh.baseApplies}`,
    );
    check(
      "an unknown stored scheme id falls back to the mode's base",
      beh.unknownFallback === "default-dark",
      `schemeFor('dark') returned ${beh.unknownFallback}`,
    );
    check(
      "a scheme id stored under the other mode's key is not applied",
      beh.foreignModeFallback === "default-light",
      `schemeFor('light') returned ${beh.foreignModeFallback}`,
    );
    check(
      "an export parks the scheme, so a dark scheme is not printed onto white paper",
      beh.parked === "none" && beh.before === "ember/dark",
      `before=${beh.before} parked=${beh.parked}`,
    );
    check(
      "a scheme picked mid-export lands only once the export releases",
      beh.heldNoOp === "none" && beh.holdReportedUp === true && beh.restored === "abyss/dark",
      `data-theme during hold=${beh.heldNoOp} held=${beh.holdReportedUp} after release=${beh.restored} - "abyss/dark" is the proof the release reads the STORED preference rather than replaying the value parked before the hold, which was ember`,
    );
    check(
      "the scheme is restored from the stored preference once the export releases",
      beh.restored === "abyss/dark" && beh.holdReportedDown === false,
      `restored=${beh.restored} held=${beh.holdReportedDown}`,
    );

    // ── 10i: THE PRINTED PAGE, AND THE TWO SCOPE BOUNDARIES ─────────────────
    /* Everything above measures the page on SCREEN. printToPDF renders it
       under `@media print`, which is a different cascade, and this is the only
       section that looks at it.

       IT ALSO CORRECTS AN ASSUMPTION THIS FILE USED TO CARRY. A first probe
       measured `body` and `#viewer` under print emulation, found all six theme
       states resolving to rgb(51,51,51) on white, and concluded the print
       stylesheet neutralises schemes on its own. It does not. Measuring the
       rest of the page shows the neutralisation is scoped:

         - unconditional: body, #viewer                (styles.css:2172,
                                                        custom-styles.css:341)
         - only when body.dark-mode is present: headings, p, li, td, th,
           blockquote, code, pre, table borders, links  (custom-styles.css:355-412)
         - never, in any mode: every .token.* syntax colour

       So on paper, a LIGHT scheme keeps its own code box and its own tokens,
       and a DARK scheme gets a forced-light code box (#f5f5f5) still painted
       with tokens chosen for a near-black one - measured at 2.05:1 (abyss
       keyword), 2.14 (default dark) and 2.38 (ember).

       None of that is reachable through the product, and the reason is the
       whole point of this section: `prepare-for-pdf-export` strips the scheme
       AND the dark class BEFORE main calls printToPDF (renderer.js:2445-2455,
       main.js:1075-1079), and printToPDF on the main window is the only path
       that ever renders this document to paper - there is no
       webContents.print() and no print accelerator anywhere in src/.

       THE GUARANTOR IS THEREFORE THE JS PARK, NOT THE STYLESHEET, and that is
       what the assertions below say. 10e already covers the park's own
       semantics from the registry side; this covers what the reader actually
       gets on paper, by driving the REAL handler over its REAL ready signal.

       Observation recorded rather than asserted: the handler reports ready
       after a double rAF, while the colour transitions a mode change starts
       run for 0.2-0.3s, so printToPDF can in principle capture a page still
       in flight. Asserting on that would be a timing bet; the settle below is
       this instrument being honest about what it measures, not a claim that
       the product waits. */
    const PRINT_SURFACES = [
      "body",
      "#viewer",
      "#viewer p",
      "#viewer a",
      "#viewer h1",
      "#viewer h2",
      "#viewer h3",
      "#viewer blockquote",
      "#viewer pre",
      "#viewer pre code",
      "#viewer th",
      "#viewer td",
      "#viewer .token.comment",
      "#viewer .token.keyword",
    ];
    const PRINT_PROBE = `(() => {
      const SELS = ${JSON.stringify(PRINT_SURFACES)};
      const parse = (s) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(s || '');
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const rgb = (c) => c ? 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')' : 'none';
      /* Same compositing rule as 10d: walk up until an opaque fill is found,
         then flatten. A scheme that tints a code box with a translucent layer
         must not read as its opaque ancestor. */
      const surface = (el) => {
        const st = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) { st.push(c); if (c.a >= 0.999) break; }
        }
        let out = { r: 255, g: 255, b: 255 };
        for (let i = st.length - 1; i >= 0; i--) {
          const c = st[i];
          out = {
            r: c.a * c.r + (1 - c.a) * out.r,
            g: c.a * c.g + (1 - c.a) * out.g,
            b: c.a * c.b + (1 - c.a) * out.b,
          };
        }
        return out;
      };
      const out = { cells: {}, missing: [] };
      for (const sel of SELS) {
        const el = sel === 'body' ? document.body : document.querySelector(sel);
        if (!el) { out.missing.push(sel); continue; }
        out.cells[sel] = rgb(parse(getComputedStyle(el).color)) + ' on ' + rgb(surface(el));
      }
      const h = document.querySelector('.header');
      out.headerDisplay = h ? getComputedStyle(h).display : 'ABSENT';
      out.printMediaActive = window.matchMedia('print').matches;
      out.residue = (document.body.getAttribute('data-theme') || 'none') + '/' +
        (document.body.classList.contains('dark-mode') ? 'dark' : 'light');
      return JSON.stringify(out);
    })()`;

    const PRINT_STATES = [
      ["light", null, "default-light"],
      ["light", "clarity", "clarity"],
      ["light", "parchment", "parchment"],
      ["dark", null, "default-dark"],
      ["dark", "abyss", "abyss"],
      ["dark", "ember", "ember"],
    ];
    const printRaw = {};
    const printPrepared = {};
    const mermaidCfg = {};
    const prepFailures = [];
    let printAttached = false;
    const printRestored = {};
    try {
      win.webContents.debugger.attach("1.3");
      printAttached = true;
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        media: "print",
      });
      for (const [mode, scheme, label] of PRINT_STATES) {
        await applySettled(mode, scheme, `10i ${label}`);
        // Measured BEFORE the export preparation: this is what the stylesheet
        // alone does, and it is what makes the claim below non-vacuous.
        printRaw[label] = JSON.parse(await exec(PRINT_PROBE));
        mermaidCfg[label] = await exec(
          `JSON.stringify({ dark: getMermaidConfig(true), light: getMermaidConfig(false) })`,
        );

        /* Waited on the PRODUCT'S OWN readiness signal - the same
           `pdf-export-ready` main.js:1076 blocks on - rather than on a DOM
           predicate. A predicate like "data-theme is absent" is ALREADY TRUE
           for default-light and would have measured nothing there while
           looking identical to a real wait. */
        let settleReady;
        const ready = new Promise((resolve) => {
          settleReady = resolve;
          ipcMain.once("pdf-export-ready", resolve);
        });
        const timer = setTimeout(() => {
          ipcMain.removeListener("pdf-export-ready", settleReady);
          settleReady("TIMEOUT");
        }, 15000);
        await exec(
          `(() => { require('electron').ipcRenderer.emit('prepare-for-pdf-export'); return 1; })()`,
        );
        if ((await ready) === "TIMEOUT") prepFailures.push(`${label}: no pdf-export-ready`);
        clearTimeout(timer);
        for (let i = 0; i < 60; i++) {
          const running = await settleTransitions();
          maxRunning = Math.max(maxRunning, running);
          if (running === 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        printPrepared[label] = JSON.parse(await exec(PRINT_PROBE));

        // Release through the real result handler so the hold cannot leak into
        // the next state, and so restoreExportScheme() is exercised each pass.
        await exec(
          `(() => { require('electron').ipcRenderer.emit('pdf-export-result', {}, ` +
            `{ success: true, path: 'C:/tmp/10i-probe.pdf' }); return 1; })()`,
        );
        await new Promise((r) => setTimeout(r, 60));
        /* THE OTHER HALF OF THE PARK, MEASURED THROUGH ITS REAL CALL SITE.
           parkExportScheme()'s call site is pinned by R317; its partner's was
           not, because every test that exercises restore called the function
           DIRECTLY. Deleting `restoreExportScheme();` from the
           pdf-export-result handler therefore failed nothing, while leaving
           exactly the regression renderer.js argues these are separate
           primitives to prevent: a reader whose scheme was stripped for an
           export never gets it back for the rest of the session. */
        printRestored[label] = JSON.parse(
          await exec(
            `JSON.stringify({ attr: document.body.getAttribute('data-theme'),` +
              ` dark: document.body.classList.contains('dark-mode') })`,
          ),
        );
      }
    } finally {
      if (printAttached) {
        try {
          await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "" });
        } catch (e) {
          /* detaching matters more than restoring the media type */
        }
        try {
          win.webContents.debugger.detach();
        } catch (e) {
          /* already gone */
        }
      }
    }

    const printedStates = Object.keys(printPrepared);
    /* WITHOUT THIS, EVERY CLAIM BELOW PASSES ON THE SCREEN CASCADE. The park
       makes all six states identical whether or not print media is in effect,
       so a silently-failed Emulation.setEmulatedMedia would leave the
       invariance assertion green while measuring the wrong medium entirely.
       Two independent oracles: the engine's own matchMedia, and .header being
       hidden, which only the print block does. */
    const mediaBad = []
      .concat(Object.entries(printRaw), Object.entries(printPrepared))
      .filter(([, v]) => !(v.printMediaActive && v.headerDisplay === "none"))
      .map(([k, v]) => `${k}: matchMedia=${v.printMediaActive} header=${v.headerDisplay}`);
    check(
      "10i: the print stylesheet really was in effect for every printed measurement (positive control)",
      mediaBad.length === 0 && printedStates.length === PRINT_STATES.length,
      `${printedStates.length}/${PRINT_STATES.length} states measured; ${mediaBad.slice(0, 3).join(" | ")}`,
    );

    const refCells = printPrepared["default-light"] ? printPrepared["default-light"].cells : {};
    const measuredSels = Object.keys(refCells);
    const MUST_REACH = ["#viewer pre", "#viewer .token.comment", "#viewer .token.keyword"];
    const anyMissing = printedStates
      .filter((k) => printPrepared[k].missing.length)
      .map((k) => `${k}: ${printPrepared[k].missing.join(",")}`);
    check(
      "10i: the printed-page sweep reached the surfaces the print stylesheet never neutralises",
      measuredSels.length >= 9 &&
        MUST_REACH.every((s) => measuredSels.includes(s)) &&
        anyMissing.length === 0,
      `${measuredSels.length} surfaces measured; missing ${anyMissing.join(" | ") || "none"} - the token cells are the ones no @media print rule touches, so a sweep that loses them proves nothing`,
    );

    check(
      "10i: the export preparation completed through its own pdf-export-ready signal",
      prepFailures.length === 0,
      prepFailures.join(" | "),
    );

    /* THE PARK IS ONLY SAFE IF IT IS UNDONE, and this measures the undo
       through the real pdf-export-result handler rather than by calling
       restoreExportScheme() directly the way 10e and 10k do. PRINT_STATES
       carries [mode, scheme, label], so the expected landing state is the
       state the loop applied - and for a base state that means data-theme
       genuinely absent, not merely "some value". */
    const restoreMisses = PRINT_STATES.filter(([mode, scheme, label]) => {
      const got = printRestored[label];
      if (!got) return true;
      return got.attr !== (scheme || null) || got.dark !== (mode === "dark");
    }).map(
      ([mode, scheme, label]) =>
        `${label} -> data-theme=${JSON.stringify(printRestored[label]?.attr ?? "<never measured>")} dark=${printRestored[label]?.dark} (wanted ${JSON.stringify(scheme || null)} / ${mode})`,
    );
    check(
      "10i: the export result handler puts the reader's scheme back, so an export does not strip it for the session",
      restoreMisses.length === 0 && Object.keys(printRestored).length === PRINT_STATES.length,
      restoreMisses.join(" | "),
    );

    // THE CAUSE. Named separately from the consequence below because the two
    // fail under different accidents: a scheme that stored its state somewhere
    // parkExportScheme() does not clear would fail this one first.
    const residue = printedStates
      .filter((k) => printPrepared[k].residue !== "none/light")
      .map((k) => `${k} -> ${printPrepared[k].residue}`);
    check(
      "10i: the export preparation leaves no scheme or dark-mode residue on the page printToPDF captures",
      residue.length === 0,
      residue.join(" | "),
    );

    // THE CONSEQUENCE.
    const printDiffs = [];
    for (const label of printedStates) {
      if (label === "default-light") continue;
      for (const sel of measuredSels) {
        if (printPrepared[label].cells[sel] !== refCells[sel]) {
          printDiffs.push(`${label} ${sel}: ${printPrepared[label].cells[sel]} != ${refCells[sel]}`);
        }
      }
    }
    check(
      "10i: every theme state prints each measured surface exactly as the shipped light default does",
      printDiffs.length === 0 && printedStates.length === PRINT_STATES.length,
      printDiffs.slice(0, 5).join(" | "),
    );

    /* POSITIVE CONTROL FOR THE PARK, and the reason the assertion above is not
       a tautology. It measures the SAME six states under the SAME print media
       with the export preparation NOT run, and requires them to disagree - so
       the invariance above is demonstrably produced by the park rather than by
       the stylesheet.
       IF THIS EVER FAILS, the print CSS has been widened to neutralise schemes
       and tokens on its own. That is an improvement, not a regression: check
       that the park is still wanted, then retire this control deliberately.
       It must not be "fixed" by loosening it. */
    const rawRef = printRaw["default-light"] ? printRaw["default-light"].cells : {};
    const rawDiffering = printedStates.filter(
      (label) =>
        label !== "default-light" &&
        measuredSels.some((sel) => printRaw[label].cells[sel] !== rawRef[sel]),
    );
    check(
      "10i: the print stylesheet alone does not neutralise a scheme, so the export park is load-bearing (control)",
      rawDiffering.length >= 3,
      `only ${rawDiffering.length} of ${printedStates.length - 1} states printed differently without the export preparation (${rawDiffering.join(",")}) - see the note above before changing this`,
    );

    /* THE MERMAID BOUNDARY. custom-theme.js:69-74 records in prose that mermaid
       is binary - two fixed palettes chosen by a boolean - which is why a
       same-mode scheme switch never re-themes a diagram and why there is no
       mixed-theme bug. This turns that prose into a measurement: the config is
       captured under all six theme states and must not move. */
    const cfgRef = mermaidCfg["default-light"];
    const cfgDrift = Object.keys(mermaidCfg).filter((k) => mermaidCfg[k] !== cfgRef);
    check(
      "10i: mermaid's configuration is decided by the mode alone, never by the scheme",
      cfgDrift.length === 0 && Object.keys(mermaidCfg).length === PRINT_STATES.length,
      `configuration moved under: ${cfgDrift.join(",")}`,
    );
    const cfgPair = JSON.parse(cfgRef || '{"dark":1,"light":1}');
    check(
      "10i: mermaid really does distinguish the two modes (positive control)",
      JSON.stringify(cfgPair.dark) !== JSON.stringify(cfgPair.light),
      "if the two modes produce the same config, the invariance above is satisfied by a function that discriminates nothing",
    );

    /* THE POPUP BOUNDARY. Every popup is a separate BrowserWindow whose CSS is
       built in the MAIN process from a literal hex table selected by an
       isDarkMode boolean (main.js:1289 mermaid, :1653 image, :1962 table), so
       no scheme can reach one. Asserted where the boundary actually lives -
       the renderer cannot observe a window it does not own - and paired with a
       positive control, because a matcher that has stopped matching reports an
       absence as satisfied. */
    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const NON_BASE_IDS = ["clarity", "parchment", "abyss", "ember"];
    const schemeLeaks = [];
    for (const id of NON_BASE_IDS) {
      if (mainSrc.includes('"' + id + '"') || mainSrc.includes("'" + id + "'")) {
        schemeLeaks.push(id);
      }
    }
    for (const marker of ["data-theme", "--syn-", "--tok-"]) {
      if (mainSrc.includes(marker)) schemeLeaks.push(marker);
    }
    const POPUP_CHANNELS = ["open-mermaid-popup", "open-image-popup", "open-table-popup"];
    const popupsFound = POPUP_CHANNELS.filter((c) => mainSrc.includes('"' + c + '"'));
    const darkAware = (mainSrc.match(/isDarkMode/g) || []).length;
    check(
      "10i: every popup surface exists and is themed by a boolean (positive control)",
      popupsFound.length === POPUP_CHANNELS.length && darkAware >= 20,
      `found ${popupsFound.length}/${POPUP_CHANNELS.length} popup channels, ${darkAware} isDarkMode references`,
    );
    check(
      "10i: the main process, which owns every popup window, knows nothing about colour schemes",
      schemeLeaks.length === 0,
      `main.js references ${schemeLeaks.join(", ")} - a popup consuming the scheme layer moves a recorded scope boundary and needs a decision, not a passing test`,
    );

    console.log(
      `  note: printed page: ${printedStates.length} states, ${measuredSels.length} surfaces; ` +
        `${rawDiffering.length} differ without the park, ${printDiffs.length} differ with it`,
    );

    // ── 10j: THE MENU, DRIVEN THE WAY A READER DRIVES IT ────────────────────
    /* EVERY OTHER ASSERTION IN THIS FILE CALLS window.foliaThemes.setScheme()
       DIRECTLY. That is the right subject for a colour claim - it is the
       shortest path to the state being measured - but it means the surface the
       user actually touches has never been exercised: the hamburger, the View
       flyout, the grace-period hover that reveals the panel, the per-row click
       listeners, the tick bookkeeping and the dismissal are all unproven. A
       scheme layer that is perfect and unreachable ships as no feature at all,
       and nothing above this line can tell the two apart.

       So this section starts at #menuBtn and ends at localStorage, touching
       nothing in between that a reader could not touch.

       REACHABILITY IS HIT-TESTED, NOT INFERRED FROM CLASSES. HTMLElement
       .click() fires the listener on a row that is zero-sized, clipped or
       buried under another panel, so a class-and-callback test would report a
       working menu for one the mouse can never land on. Each row is therefore
       resolved through document.elementFromPoint() at its own centre, and the
       probe is made two-sided by running the identical sweep with the menu
       CLOSED and requiring it to find nothing - otherwise a probe that says
       "reachable" unconditionally looks exactly like a healthy menu.
       (Known and accepted limit, same as test-visual-utils.js records:
       elementFromPoint ignores pointer-events:none, so a decorative overlay is
       invisible to it.) */
    const MENU_PATH_PROBE = `(() => {
      const out = { missing: [], steps: [] };
      /* Start from a known-closed menu through the product's own dismissal
         path rather than by stripping classes by hand. */
      document.body.click();
      const ids = ['menuBtn', 'viewBtn', 'mainMenu', 'viewMenu', 'customThemeMenuItem'];
      const el = {};
      for (const id of ids) {
        el[id] = document.getElementById(id);
        if (!el[id]) out.missing.push(id);
      }
      if (out.missing.length) return JSON.stringify(out);
      el.menuBtn.click();
      out.steps.push(['mainMenu', el.mainMenu.classList.contains('visible')]);
      el.viewBtn.click();
      out.steps.push(['viewMenu', el.viewMenu.classList.contains('visible')]);
      /* mouseenter does not bubble and is what custom-theme.js listens for -
         the grace-period hover, not a click. */
      el.customThemeMenuItem.dispatchEvent(new MouseEvent('mouseenter'));
      out.steps.push(['themeSubmenu', el.customThemeMenuItem.classList.contains('theme-open')]);
      return JSON.stringify(out);
    })()`;

    const REACH_PROBE = `(() => {
      const rows = Array.from(document.querySelectorAll('.custom-scheme-option'));
      const out = { total: rows.length, reachable: [], unreachable: [] };
      for (const row of rows) {
        const id = row.dataset.scheme || '?';
        const r = row.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) { out.unreachable.push(id + ':zero-size'); continue; }
        const hit = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        );
        if (!hit) { out.unreachable.push(id + ':no-hit'); continue; }
        if (hit === row || row.contains(hit)) out.reachable.push(id);
        else out.unreachable.push(id + ':occluded-by-' + (hit.id || hit.className || hit.tagName));
      }
      return JSON.stringify(out);
    })()`;

    const MENU_STATE_PROBE = `(() => {
      const b = document.body;
      const item = document.getElementById('customThemeMenuItem');
      return JSON.stringify({
        dataTheme: b.getAttribute('data-theme') || 'none',
        dark: b.classList.contains('dark-mode'),
        themeMode: localStorage.getItem('themeMode'),
        lightScheme: localStorage.getItem('themeLightScheme'),
        darkScheme: localStorage.getItem('themeDarkScheme'),
        modeTicked: Array.from(document.querySelectorAll('.custom-theme-option.active'))
          .map((e) => e.dataset.mode),
        schemeTicked: Array.from(document.querySelectorAll('.custom-scheme-option.active'))
          .map((e) => e.dataset.scheme),
        mainMenuOpen: document.getElementById('mainMenu').classList.contains('visible'),
        viewMenuOpen: document.getElementById('viewMenu').classList.contains('visible'),
        themeOpen: !!item && item.classList.contains('theme-open'),
      });
    })()`;

    await applySettled("light", null, "10j: start from the shipped default");

    const menuClosedReach = JSON.parse(await exec(REACH_PROBE));
    const menuPath = JSON.parse(await exec(MENU_PATH_PROBE));
    const menuOpenReach = JSON.parse(await exec(REACH_PROBE));

    check(
      "10j: the Themes submenu opens through the real hamburger -> View -> Theme path",
      menuPath.missing.length === 0 && menuPath.steps.every(([, ok]) => ok),
      `missing ${menuPath.missing.join(",") || "none"}; ${menuPath.steps
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );

    const MENU_IDS = ["default-light", "clarity", "parchment", "default-dark", "abyss", "ember"];
    check(
      "10j: every scheme in the registry has a row the mouse can actually land on",
      menuOpenReach.total === MENU_IDS.length &&
        MENU_IDS.every((id) => menuOpenReach.reachable.includes(id)),
      `${menuOpenReach.reachable.length}/${menuOpenReach.total} reachable; unreachable ${menuOpenReach.unreachable.join(", ") || "none"}`,
    );

    /* THE CONTROL THAT MAKES THE ASSERTION ABOVE MEAN SOMETHING. The rows are
       in the DOM whether or not the menu is open, so `total` must stay 6 while
       `reachable` empties - a probe reporting 0/0 would be broken, not strict. */
    check(
      "10j: no scheme row is reachable while the menu is closed (positive control)",
      menuClosedReach.total === MENU_IDS.length && menuClosedReach.reachable.length === 0,
      `${menuClosedReach.reachable.length}/${menuClosedReach.total} reachable with the menu shut: ${menuClosedReach.reachable.join(",")}`,
    );

    /* Both base rows are included deliberately: a base scheme applies by
       REMOVING data-theme, so it is the one row whose success looks identical
       to the row having done nothing at all. It is only distinguishable
       because the row before it in this list leaves a scheme applied. */
    const MENU_CLICKS = [
      ["clarity", "light"],
      ["abyss", "dark"],
      ["default-dark", "dark"],
      ["parchment", "light"],
      ["ember", "dark"],
      ["default-light", "light"],
    ];
    const clickResults = [];
    const clickUnreachable = [];
    for (const [id, mode] of MENU_CLICKS) {
      const opened = JSON.parse(await exec(MENU_PATH_PROBE));
      if (opened.missing.length || !opened.steps.every(([, ok]) => ok)) {
        clickUnreachable.push(`${id}: submenu would not open`);
        continue;
      }
      const sel = `.custom-scheme-option[data-scheme=${JSON.stringify(id)}]`;
      /* CAPTURED BEFORE THE CLICK, because "leaving the other mode's alone" is
         a statement about a VALUE and not about a value's shape. Reading only
         afterwards, the strongest thing that can be said is that the other key
         holds some recognised scheme id - which a bug that overwrites it with
         a different valid id satisfies perfectly, and the tick check that
         follows would then agree with the clobbered store and pass too. */
      const before = JSON.parse(await exec(MENU_STATE_PROBE));
      const clicked = JSON.parse(
        await exec(`(() => {
          const row = document.querySelector(${JSON.stringify(sel)});
          if (!row) return JSON.stringify({ found: false });
          const r = row.getBoundingClientRect();
          const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(r.top + r.height / 2),
          );
          const reachable = !!hit && (hit === row || row.contains(hit));
          const label = row.textContent.trim();
          if (reachable) row.click();
          return JSON.stringify({ found: true, reachable: reachable, label: label });
        })()`),
      );
      if (!clicked.found || !clicked.reachable) {
        clickUnreachable.push(`${id}: found=${clicked.found} reachable=${clicked.reachable}`);
        continue;
      }
      // The row handler dismisses the menu on a 10ms timer (custom-theme.js),
      // so the dismissal is only observable after it has run.
      await new Promise((r) => setTimeout(r, 80));
      const state = JSON.parse(await exec(MENU_STATE_PROBE));
      clickResults.push({ id, mode, label: clicked.label, state, before });
    }

    check(
      "10j: every scheme row was reached and clicked as a mouse would reach it",
      clickUnreachable.length === 0 && clickResults.length === MENU_CLICKS.length,
      `${clickResults.length}/${MENU_CLICKS.length} clicked; ${clickUnreachable.join(" | ")}`,
    );

    const applyMisses = clickResults
      .filter((r) => {
        const isBase = r.id.startsWith("default-");
        const wantTheme = isBase ? "none" : r.id;
        return r.state.dataTheme !== wantTheme || r.state.dark !== (r.mode === "dark");
      })
      .map(
        (r) =>
          `${r.id} -> data-theme=${r.state.dataTheme} dark=${r.state.dark} (wanted ${r.mode})`,
      );
    check(
      "10j: clicking a scheme row applies that scheme, and switches mode with it",
      applyMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      applyMisses.join(" | "),
    );

    /* THE PERSISTENCE HALF, WHICH IS WHAT MAKES THE CHOICE SURVIVE A RESTART.
       Keyed per mode on purpose (SCHEME_KEYS), so a dark choice must land in
       themeDarkScheme and must NOT disturb themeLightScheme - the property
       that lets "Follow Desktop" answer at both ends of the day. */
    const storeMisses = clickResults
      .filter((r) => {
        const key = r.mode === "dark" ? "darkScheme" : "lightScheme";
        const other = r.mode === "dark" ? "lightScheme" : "darkScheme";
        const otherUntouched = (r.state[other] ?? null) === (r.before[other] ?? null);
        return r.state[key] !== r.id || r.state.themeMode !== r.mode || !otherUntouched;
      })
      .map(
        (r) =>
          `${r.id} -> themeMode=${r.state.themeMode} light=${r.state.lightScheme} dark=${r.state.darkScheme} (other key was ${JSON.stringify(r.before[r.mode === "dark" ? "lightScheme" : "darkScheme"] ?? null)}, is now ${JSON.stringify(r.state[r.mode === "dark" ? "lightScheme" : "darkScheme"] ?? null)})`,
      );
    check(
      "10j: the choice is stored under its own mode's key, leaving the other mode's alone",
      storeMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      storeMisses.join(" | "),
    );

    const stillOpen = clickResults
      .filter((r) => r.state.mainMenuOpen || r.state.viewMenuOpen || r.state.themeOpen)
      .map(
        (r) =>
          `${r.id} -> main=${r.state.mainMenuOpen} view=${r.state.viewMenuOpen} theme=${r.state.themeOpen}`,
      );
    check(
      "10j: choosing a scheme dismisses the menu it was chosen from",
      stillOpen.length === 0 && clickResults.length === MENU_CLICKS.length,
      stillOpen.join(" | "),
    );

    /* THE TICK IS A TWO-GROUP CLAIM, and that is the interesting part.
       markActive() ticks a scheme row when it is the stored choice for ITS OWN
       mode, so BOTH groups carry a tick at once and the reader can see what
       Follow Desktop will pick at either end of the day. Ticking only the
       active mode's group is the natural simplification and would leave the
       other group looking unset when it is not - so "exactly one per group"
       and "the tick names the stored id" are asserted separately from the
       count, because a one-group implementation still satisfies a bare count
       of 1. */
    const LIGHT_IDS = ["default-light", "clarity", "parchment"];
    const tickMisses = [];
    for (const r of clickResults) {
      const lit = r.state.schemeTicked.filter((s) => LIGHT_IDS.includes(s));
      const drk = r.state.schemeTicked.filter((s) => !LIGHT_IDS.includes(s));
      if (lit.length !== 1 || drk.length !== 1) {
        tickMisses.push(`${r.id}: ticked [${r.state.schemeTicked.join(",")}]`);
      } else if (lit[0] !== r.state.lightScheme || drk[0] !== r.state.darkScheme) {
        tickMisses.push(
          `${r.id}: ticked ${lit[0]}/${drk[0]} but stored ${r.state.lightScheme}/${r.state.darkScheme}`,
        );
      }
    }
    check(
      "10j: each scheme group carries exactly one tick, and it names that group's stored choice",
      tickMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      tickMisses.join(" | "),
    );

    const modeTickMisses = clickResults
      .filter((r) => r.state.modeTicked.length !== 1 || r.state.modeTicked[0] !== r.state.themeMode)
      .map((r) => `${r.id}: ticked [${r.state.modeTicked.join(",")}] for themeMode=${r.state.themeMode}`);
    check(
      "10j: exactly one mode row is ticked, and it names the stored themeMode",
      modeTickMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      modeTickMisses.join(" | "),
    );

    /* The ticks are painted by markActive() at the moment of the choice and are
       never re-applied on open, so this is the assertion that the row classes
       are not merely correct for one frame. It also covers the reader's real
       question - "which one am I on?" - which is only ever asked with the menu
       open. */
    await exec(MENU_PATH_PROBE);
    const reopened = JSON.parse(await exec(MENU_STATE_PROBE));
    const reopenedLight = reopened.schemeTicked.filter((s) => LIGHT_IDS.includes(s));
    const reopenedDark = reopened.schemeTicked.filter((s) => !LIGHT_IDS.includes(s));
    check(
      "10j: the ticks still describe the stored choice when the menu is reopened",
      reopenedLight.length === 1 &&
        reopenedDark.length === 1 &&
        reopenedLight[0] === reopened.lightScheme &&
        reopenedDark[0] === reopened.darkScheme &&
        reopened.modeTicked.length === 1 &&
        reopened.modeTicked[0] === reopened.themeMode,
      `reopened with ticks [${reopened.schemeTicked.join(",")}] / [${reopened.modeTicked.join(",")}] against stored ${reopened.lightScheme}/${reopened.darkScheme}/${reopened.themeMode}`,
    );

    /* The labels are what the reader chooses BY, so a row wired to the right id
       under the wrong label is a defect no state assertion can see. Compared
       against the registry the menu is built from rather than a second copy of
       the list. */
    const labelMisses = [];
    for (const r of clickResults) {
      const want = await exec(
        `(() => { const s = window.foliaThemes.SCHEMES.find((x) => x.id === ${JSON.stringify(r.id)}); return s ? s.label : ''; })()`,
      );
      if (r.label !== want) labelMisses.push(`${r.id}: row reads "${r.label}", registry says "${want}"`);
    }
    check(
      "10j: every row is labelled with its registry label",
      labelMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      labelMisses.join(" | "),
    );

    await exec(`(() => { document.body.click(); return 1; })()`);
    {
      let running = -1;
      for (let i = 0; i < 60; i++) {
        running = await settleTransitions();
        maxRunning = Math.max(maxRunning, running);
        if (running === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (running !== 0) settleFailures.push(`10j menu drive: ${running} still running`);
    }

    console.log(
      `  note: menu e2e: ${clickResults.length}/${MENU_CLICKS.length} rows driven from #menuBtn; ` +
        `${menuOpenReach.reachable.length} reachable open, ${menuClosedReach.reachable.length} closed`,
    );

    /* ── 10k. ONE STORED-MODE RESOLVER ─────────────────────────────────────
       The legacy-'darkMode' migration rule used to be written down five times:
       once in renderer.js's resolveDarkPreference() - which decides the dark
       CLASS - and four times in custom-theme.js as a bare
       `localStorage.getItem('themeMode') || 'desktop'`, which does NOT consult
       the legacy key. On a profile that has only ever run the legacy build the
       two therefore answer differently, and the difference is not academic:
       measured, with the OS resolving light, the class said dark while the
       scheme sites said light, so `data-theme` landed on a LIGHT scheme
       (parchment, body background rgb(244,239,228)) underneath `.dark-mode`.

       THAT STATE IS NOT REACHABLE IN THE SHIPPED APP TODAY, and this comment
       says so rather than overselling the fix: applyTheme() is the only writer
       of 'themeMode' and init() calls it unconditionally, so a stored scheme
       implies a stored mode. It was one deleted migration block away, and the
       resolvers really did disagree - which is what this section measures.

       The state is forced rather than waited for, and window.matchMedia is
       stubbed to answer LIGHT so the legacy value ('dark') and the raw
       fallback ('desktop' -> OS) cannot agree by accident on this machine.
       Assertion 2 is the positive control for exactly that: if the stub failed
       the two answers would coincide and every assertion below would pass for
       the wrong reason.

       Four of the five sites are driven through real product functions. The
       fifth - markActive()'s `mode || storedMode()` - has a single caller and
       that caller always passes a mode, so its fallback is unreachable and is
       left unified without an independent pin. */
    const resolverProbe = await exec(`(() => {
      const before = {
        themeMode: localStorage.getItem("themeMode"),
        darkMode: localStorage.getItem("darkMode"),
        light: localStorage.getItem("themeLightScheme"),
        dark: localStorage.getItem("themeDarkScheme"),
        cls: document.body.classList.contains("dark-mode"),
        attr: document.body.getAttribute("data-theme"),
      };
      const realMM = window.matchMedia;
      window.matchMedia = (q) => ({
        matches: false, media: q,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      });

      const out = { before: before };
      try {
        localStorage.removeItem("themeMode");
        localStorage.setItem("darkMode", "enabled");
        localStorage.setItem("themeLightScheme", "parchment");
        localStorage.setItem("themeDarkScheme", "ember");

        const t = window.foliaThemes;
        out.exportsResolver = typeof window.resolveStoredMode;

        // The exact expression every scheme site used before unification.
        out.rawRead = localStorage.getItem("themeMode") || "desktop";
        out.rawResolved = t.resolveMode(out.rawRead);
        out.legacyKey = localStorage.getItem("darkMode");

        out.overlayMode = t.storedMode();
        out.rendererMode =
          typeof window.resolveStoredMode === "function"
            ? window.resolveStoredMode()
            : "NOT-EXPORTED";

        // Site: restoreExportScheme() in renderer.js, driven for real.
        document.body.removeAttribute("data-theme");
        window.restoreExportScheme();
        out.exportRestoreAttr = document.body.getAttribute("data-theme");

        // Site: setScheme() in custom-theme.js. Picking a LIGHT scheme while
        // the migrated mode is dark is the one input that separates the two
        // resolvers: with the raw read the mode is 'desktop', the stubbed OS
        // resolves light, keepFollowing is TRUE and 'themeMode' is left on
        // 'desktop'; with the migrated mode it is 'dark', keepFollowing is
        // false, and the pick concretely switches the app to light.
        t.setScheme("parchment");
        out.afterSetScheme = localStorage.getItem("themeMode");
      } catch (e) {
        out.error = String((e && e.message) || e);
      } finally {
        window.matchMedia = realMM;
        const put = (k, v) =>
          v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
        put("themeMode", before.themeMode);
        put("darkMode", before.darkMode);
        put("themeLightScheme", before.light);
        put("themeDarkScheme", before.dark);
        document.body.classList.toggle("dark-mode", before.cls);
        if (before.attr === null) document.body.removeAttribute("data-theme");
        else document.body.setAttribute("data-theme", before.attr);
      }
      return out;
    })()`);

    check(
      "10k: renderer.js exports resolveStoredMode for the overlay to consume",
      resolverProbe.exportsResolver === "function",
      `typeof window.resolveStoredMode = ${resolverProbe.exportsResolver}; ` +
        `without it custom-theme.js silently falls back to the raw read this section exists to remove`,
    );

    check(
      "10k: positive control: the pre-unification raw read really does disagree here",
      resolverProbe.legacyKey === "enabled" &&
        resolverProbe.rawRead === "desktop" &&
        resolverProbe.rawResolved === "light",
      `legacy=${resolverProbe.legacyKey} raw=${resolverProbe.rawRead} ` +
        `rawResolved=${resolverProbe.rawResolved} (want enabled/desktop/light; ` +
        `if these agree with the migrated answer the matchMedia stub failed and 10k proves nothing)`,
    );

    check(
      "10k: the overlay's stored-mode helper honours the legacy darkMode key",
      resolverProbe.overlayMode === "dark",
      `foliaThemes.storedMode() = ${resolverProbe.overlayMode}, want dark${resolverProbe.error ? ` [${resolverProbe.error}]` : ""}`,
    );

    check(
      "10k: the overlay and renderer.js resolve the SAME stored mode",
      resolverProbe.overlayMode === resolverProbe.rendererMode,
      `overlay=${resolverProbe.overlayMode} renderer=${resolverProbe.rendererMode}`,
    );

    check(
      "10k: restoreExportScheme() applies the scheme of the migrated mode",
      resolverProbe.exportRestoreAttr === "ember",
      `data-theme after restoreExportScheme() = ${resolverProbe.exportRestoreAttr}, want ember ` +
        `(parchment means a light scheme was applied under the dark class)`,
    );

    check(
      "10k: setScheme() decides Follow Desktop from the migrated mode",
      resolverProbe.afterSetScheme === "light",
      `themeMode after setScheme('parchment') = ${resolverProbe.afterSetScheme}, want light ` +
        `(desktop means keepFollowing was computed from the un-migrated 'desktop')`,
    );

    {
      let running = -1;
      for (let i = 0; i < 60; i++) {
        running = await settleTransitions();
        maxRunning = Math.max(maxRunning, running);
        if (running === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (running !== 0) settleFailures.push(`10k resolver: ${running} still running`);
    }

    // Leave the page in the shipped default so nothing after this section - or
    // a screenshot taken from the same profile - inherits a scheme.
    await applySettled("light", null, "restore to shipped default");

    // Reported LAST so it covers every state 10c/10d measured. A colour read
    // while a transition is in flight is the PREVIOUS scheme's colour and is
    // indistinguishable from a surface the new scheme cannot reach, so if this
    // fails every accent-survival and contrast result above is unreliable -
    // which is a different and much worse thing than one of them failing.
    check(
      "every theme state settled its CSS transitions before it was measured",
      settleFailures.length === 0,
      settleFailures.join(" | "),
    );
    /* POSITIVE CONTROL FOR THE SETTLE, and it closes a fail-open hole the
       assertion above cannot see. settleTransitions() filters on
       `a instanceof CSSTransition` with a `typeof CSSTransition !== 'undefined'`
       guard. If that global is ever absent - a sandboxed renderer, a Chromium
       rename - the predicate is false for EVERY animation, `running` is 0 on
       the first poll, the loop breaks without waiting, settleFailures stays
       empty and the assertion above passes while no settling happened at all.
       R300 cannot catch it either: a stretched transition is still a
       CSSTransition, so a dead filter makes the stretch invisible.
       So this asserts the wait OBSERVED something. Theme changes reliably
       start `transition: background` on the update buttons, so a zero here
       means the instrument is broken, not that the page was already calm. */
    check(
      "the settle wait actually observed running CSS transitions (positive control)",
      maxRunning > 0,
      `the highest number of running transitions seen across every theme change was ${maxRunning} - if the filter is dead this is 0 and every settle above was a no-op`,
    );
  } catch (e) {
    check("harness ran without throwing", false, e && e.stack ? e.stack.slice(0, 400) : String(e));
  }

  clearTimeout(watchdog);
  finish();
});
