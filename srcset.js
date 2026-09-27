"use strict";

// Shared by content.js (injected before it) and offscreen.js (loaded before it
// in offscreen.html), so both sides parse srcset identically.

// Parses a srcset attribute into candidates. A URL token ends at whitespace,
// not at a comma, so splitting on "," corrupts data: URIs (whose base64 payload
// contains commas) and URLs that carry a comma in the query string.
function parseSrcset(value) {
  const candidates = [];
  const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
  let i = 0;

  while (i < value.length) {
    while (i < value.length && (isSpace(value[i]) || value[i] === ",")) i += 1;
    if (i >= value.length) break;

    const start = i;
    while (i < value.length && !isSpace(value[i])) i += 1;
    const token = value.slice(start, i);

    if (token.endsWith(",")) {
      const bare = token.replace(/,+$/, "");
      if (bare) candidates.push({ url: bare, descriptor: "" });
      continue;
    }

    let descriptor = "";
    let depth = 0;
    while (i < value.length) {
      const ch = value[i];
      if (ch === "(") depth += 1;
      else if (ch === ")" && depth > 0) depth -= 1;
      else if (ch === "," && depth === 0) {
        i += 1;
        break;
      }
      descriptor += ch;
      i += 1;
    }
    if (token) candidates.push({ url: token, descriptor: descriptor.trim() });
  }
  return candidates;
}

function formatSrcset(candidates) {
  return candidates
    .filter((candidate) => candidate.url)
    .map((candidate) => (candidate.descriptor ? `${candidate.url} ${candidate.descriptor}` : candidate.url))
    .join(", ");
}
