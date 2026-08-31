/* SHARED SOURCE-SCANNING HELPERS FOR THE TEST SUITES.
   Extracted rather than copied. Two suites need to read JavaScript source and
   ask a structural question about it, and a second hand-maintained copy of a
   scanner is this project's recorded defect shape - the duplicated overlay
   check in post-upstream-merge.sh reported five correctly-declared files as
   MISSING while its twin passed, and the drifted copy is what made that
   invisible. One implementation, two consumers, one place to harden. */

/* THE STRIPPER TREATS A BACKTICK AS AN ORDINARY QUOTE and does NOT descend
   into an interpolation, so code inside one is scanned as if it were string
   content - which can only ever ADD subjects, never remove them. R384 measured
   the proposed "improvement" (re-enter code mode at `${`) and it is HARMFUL: a
   nested template toggles the quote state twice, so the outer terminator opens
   a fresh string and everything after it - including real line comments - is
   scanned as string content. Do not re-litigate that without reading R384. */
const stripJsComments = (src) => {
  let out = "";
  let quote = "";
  /* REGEX LITERALS ARE A THIRD STATE, and leaving them out is not a
     cosmetic gap. src/main.js contains .replace(/"/g, "&quot;"): with no
     regex state the lone quote inside that literal opens phantom string
     mode, and everything after it is scanned with a desynchronised quote -
     measured at 83 of 464 comment lines surviving the strip. Today that
     direction is safe (a surviving comment can only ADD a hit, and there
     are none), but the same desync lets a // inside a real string be
     stripped as a comment, which DELETES code from the sweep's view and
     fails silently open. main.js already carries such shapes nearby
     (/^file:\/\/(?!\/)/i). Deciding regex-vs-division needs the previous
     significant token, which is what lastSig/lastWord carry. */
  let lastSig = "";
  let lastWord = "";
  const REGEX_OK_AFTER = "(,=:[!&|?{};+-*%^~<>";
  const REGEX_OK_WORDS = [
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "throw",
    "do",
    "else",
    "case",
    "yield",
    "await",
  ];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += src[++i] || "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      lastSig = ch;
      lastWord = "";
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 1;
      out += " ";
      continue;
    }
    if (
      ch === "/" &&
      (lastSig === "" || REGEX_OK_AFTER.includes(lastSig) || REGEX_OK_WORDS.includes(lastWord))
    ) {
      out += ch;
      let inClass = false;
      let j = i + 1;
      for (; j < src.length; j++) {
        const c2 = src[j];
        if (c2 === "\n") break;
        out += c2;
        if (c2 === "\\") {
          out += src[++j] || "";
          continue;
        }
        if (c2 === "[") inClass = true;
        else if (c2 === "]") inClass = false;
        else if (c2 === "/" && !inClass) break;
      }
      i = j;
      lastSig = "/";
      lastWord = "";
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      lastWord = /[A-Za-z0-9_$]/.test(ch) ? lastWord + ch : "";
      lastSig = ch;
    }
  }
  return out;
};

module.exports = { stripJsComments };
