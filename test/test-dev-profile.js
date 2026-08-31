// Proves devProfileDecision(): a development run (`electron .`) is given a
// profile of its own instead of silently sharing the installed app's, and -
// just as important - DECLINES to move a profile something else has already
// relocated.
//
// The function is executed out of main.js rather than reimplemented here: the
// source text is sliced and evaluated, so what runs is the shipped code. If
// main.js is refactored such that the slice no longer matches, this fails loud
// rather than silently testing nothing.
//
// Pure, so it is driven directly against a stub rather than by booting Electron
// twice and looking at where files landed. The three inputs it reads are the
// three a stub can supply: isPackaged, getName() and getPath().
//
// The positive half cannot be asserted from inside a windowed suite, because
// every windowed suite requires test-userdata-isolation.js first and the
// decision correctly declines once a profile has been relocated - so there the
// answer is always "already-relocated". test/test-startup-perf.js asserts that
// NEGATIVE half live, which is where the damage would show; this is where the
// positive half is reachable at all.
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS  " + name);
    pass++;
  } else {
    // Separator is "  -> ", matching every other suite: the revert harness
    // recovers an assertion NAME by splitting a FAIL line there, so a suite
    // that formats its evidence differently lets a revert's `expect` regex be
    // satisfied by evidence text instead of by the assertion it names.
    console.log("FAIL  " + name + (detail ? "  -> " + detail : ""));
    fail++;
  }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "folia-dev-profile-test-"));
// Plain-node tier, so no Electron app.exit() can terminate mid-stack and the
// removal below on the normal path is reached in the ordinary case. This hook
// covers the two paths that skip it: an escaping throw from any check, and the
// early process.exit(1) in the extraction guard immediately below - both of
// which would otherwise strand the tree. Deliberately NOT the shared registry
// in test-visual-utils.js: that seam exists for the two ways an ELECTRON suite
// can terminate without reaching a removal - app.exit() unwinds nothing, so no
// finally runs, and (measured, correcting an earlier note in this repo that
// claimed otherwise) it does not reliably run process.on("exit") either, since
// whether the exit hook fires depends on whether app.exit() is reached while
// still inside the ready event's own native dispatch. Neither hazard exists
// here: this suite has no app to exit, so its exit hook always runs, and
// importing an Electron harness module into a plain-node suite would buy
// nothing.
process.on("exit", () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {
    /* best effort; a later run's mkdtemp is unaffected either way */
  }
});
const devStart = src.indexOf("const DEV_PROFILE_SUFFIX");
const devEnd = src.indexOf("function applyDevProfile", devStart);
if (devStart === -1 || devEnd === -1) {
  console.error("FAIL could not extract devProfileDecision from main.js");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const decide = new Function(
  "path",
  src.slice(devStart, devEnd) + "\nreturn devProfileDecision;"
)(path);

function fakeApp(o) {
  return {
    isPackaged: !!o.isPackaged,
    getName: () => o.name,
    getPath: (k) => (k === "appData" ? o.appData : o.userData),
  };
}
const APPDATA = path.join(root, "roaming");
const devDecision = decide(
  fakeApp({ name: "Folia", appData: APPDATA, userData: path.join(APPDATA, "Folia") })
);

check(
  "a development run is redirected to a profile of its own",
  devDecision.reason === "dev" &&
    path.resolve(devDecision.target) === path.resolve(path.join(APPDATA, "Folia-dev")),
  JSON.stringify(devDecision)
);
check(
  "the development profile is a SIBLING of the standard one, not inside it",
  path.dirname(path.resolve(devDecision.target)) === path.resolve(APPDATA) &&
    path.resolve(devDecision.target) !== path.resolve(path.join(APPDATA, "Folia")),
  JSON.stringify(devDecision)
);
// The suffix is appended to app.getName() rather than to a literal, so a rename
// of the product keeps the two profiles siblings instead of stranding the dev
// one beside a name nothing uses.
const renamedDecision = decide(
  fakeApp({ name: "Renamed", appData: APPDATA, userData: path.join(APPDATA, "Renamed") })
);
check(
  "the development profile name is derived from the app name, not hardcoded",
  renamedDecision.reason === "dev" &&
    path.resolve(renamedDecision.target) === path.resolve(path.join(APPDATA, "Renamed-dev")),
  JSON.stringify(renamedDecision)
);
check(
  "a packaged build is never redirected",
  decide(
    fakeApp({
      isPackaged: true,
      name: "Folia",
      appData: APPDATA,
      userData: path.join(APPDATA, "Folia"),
    })
  ).target === null,
  JSON.stringify(
    decide(
      fakeApp({
        isPackaged: true,
        name: "Folia",
        appData: APPDATA,
        userData: path.join(APPDATA, "Folia"),
      })
    )
  )
);
// The one that protects the harness: every windowed suite relocates userData
// before main.js loads, and clobbering that would put them all back in one
// shared profile - silently, since nothing downstream checks whose profile it
// got. Deliberately not a COUNT: a hand-maintained number is exactly the thing
// that goes stale, and a stale one reads as precision it no longer has.
const relocated = decide(
  fakeApp({
    name: "Folia",
    appData: APPDATA,
    userData: path.join(os.tmpdir(), "folia-test-userdata", "some-suite"),
  })
);
check(
  "an already-relocated profile is left exactly where it was",
  relocated.target === null && relocated.reason === "already-relocated",
  JSON.stringify(relocated)
);
// Cheap on Windows, load-bearing on Linux: the comparison is path.resolve on
// both sides and deliberately NOT lowercased. Lowercasing would report two
// genuinely different directories as the same one on a case-sensitive
// filesystem, and the failure direction matters - "same" means "nothing has
// relocated this", which is the branch that overwrites.
const caseDecision = decide(
  fakeApp({ name: "Folia", appData: APPDATA, userData: path.join(APPDATA, "FOLIA") })
);
check(
  "a userData path differing only in case is treated as a relocation, not as the default",
  caseDecision.target === null && caseDecision.reason === "already-relocated",
  JSON.stringify(caseDecision)
);

// root is removed by the process.on("exit") hook registered beside its mkdtemp.

console.log("\n=== " + pass + "/" + (pass + fail) + " passed ===");
process.exit(fail ? 1 : 0);
