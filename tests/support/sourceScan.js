// Reading this project's own source as text, for the checks that are about
// structure rather than behaviour.
//
// Both users of this are blunt instruments on purpose - a grep fails loudly the
// moment someone does the thing it forbids - but blunt has to mean blunt about
// CODE. The tracer seal originally grepped whole files and fired on a comment
// explaining why the dye is deliberately invisible there: a false positive on
// the prose documenting the rule being enforced. A test that fires on its own
// explanation gets loosened, so comments come out first.

// Deliberately simple. These files contain no regex literals and no string
// holding "//", so a character scan is exact for them, and a parser would be a
// dependency bought to answer a question this already answers.
export function stripComments(source) {
  let out = "";
  let inLine = false;
  let inBlock = false;
  let inString = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      if (c === "\\") { out += c + (next ?? ""); i++; continue; }
      if (c === inString) inString = null;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") inString = c;
    out += c;
  }
  return out;
}

// The public instance surface of a class: methods and accessors defined on its
// prototype, minus the constructor. Private #names are not reachable here at
// all, which is the point - they are not part of what a caller can enter
// through, so they are not part of what has to be covered.
export function publicSurface(Class) {
  const names = [];
  for (const name of Object.getOwnPropertyNames(Class.prototype)) {
    if (name === "constructor") continue;
    names.push(name);
  }
  return names.sort();
}
