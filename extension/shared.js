// Tracky — shared helpers. Loaded by background.js via importScripts(); the panel
// keeps a mirrored copy because content scripts cannot import (keep in sync — the
// smoke harness unit-tests this copy through the service worker).

/** Does `host` match a deny-list entry `h`? Listing example.com covers its subdomains.
 *  Leading/trailing dots are stripped so ".example.com" and the FQDN "example.com."
 *  both mean example.com. */
function hostMatches(host, h) {
  const clean = (s) => (typeof s === "string" ? s.trim().toLowerCase().replace(/^\.+|\.+$/g, "") : "");
  const n = clean(h);
  const name = clean(host);
  return !!n && !!name && (name === n || name.endsWith(`.${n}`));
}

/** The deny list, applied to a URL's hostname. */
function hostDenied(hostname, disabledHosts) {
  return Array.isArray(disabledHosts) && disabledHosts.some((h) => hostMatches(hostname, h));
}

/** Find the first SSE frame boundary (a blank line) in `buf`, accepting LF, CRLF,
 *  lone-CR or mixed framing. Matching on the raw bytes — never normalizing —
 *  means a CR at the end of one read plus LF at the start of the next can never
 *  fuse into a phantom boundary. The guards keep a CRLF atomic so the pair can
 *  never be re-read as two breaks. Returns { index, length } or null. */
function findSseBoundary(buf) {
  const m = /(?:\r\n|(?<!\r)\n|\r(?!\n)){2}/.exec(buf);
  return m ? { index: m.index, length: m[0].length } : null;
}

/** Parse one SSE frame into { ev, data } or null when the frame carries no
 *  event (heartbeat, comment, trailing whitespace). Accepts `data:` with or
 *  without the space and joins multi-line data with "\n" per the SSE spec.
 *  Never throws: an unparseable frame is skipped by the caller, never fatal. */
function parseSseFrame(frame) {
  let ev = null;
  const dataLines = [];
  for (const line of String(frame).split(/\r\n|\r|\n/)) {
    if (line.startsWith("event:")) ev = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (ev === null || ev === "") return null;
  return { ev, data: dataLines.join("\n") };
}

/** Normalize deny-list lines to hostnames. Strips scheme, credentials, path,
 *  query, fragment and :port; keeps single-label hosts (localhost), bracketed
 *  IPv6 ([::1], with optional :port) and underscores (intranet names) — all of
 *  which hostMatches above can actually match. Returns { hosts, dropped } so
 *  the options page can say what it ignored instead of dropping silently. */
function normalizeHosts(lines) {
  const hosts = [];
  const dropped = [];
  for (const rawLine of Array.isArray(lines) ? lines : []) {
    const raw = String(rawLine ?? "").trim().toLowerCase();
    if (!raw) continue; // blank lines are not entries
    if (/\s/.test(raw)) { dropped.push(raw); continue; }
    let s = raw;
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(s);
    if (scheme) s = s.slice(scheme[0].length);
    else if (s.includes("://")) { dropped.push(raw); continue; } // interior :// can only be a forgery
    const at = s.lastIndexOf("@");
    if (at !== -1) {
      if (!scheme) { dropped.push(raw); continue; } // user@host without a scheme is ambiguous
      s = s.slice(at + 1);
    }
    s = s.split(/[/?#]/)[0].replace(/\.+$/g, "");
    if (!s) { dropped.push(raw); continue; }
    let host;
    const v6 = /^\[([0-9a-f:.%]+)\](?::(\d+))?$/.exec(s);
    if (v6) {
      if (!/[0-9a-f]/i.test(v6[1])) { dropped.push(raw); continue; } // [.], [%%%%] are not addresses
      if (v6[2] !== undefined && (v6[2] === "" || Number(v6[2]) > 65535)) { dropped.push(raw); continue; }
      host = `[${v6[1]}]`; // keep the brackets: location.hostname for an IPv6 URL is "[::1]", and that is what hostMatches compares
    } else {
      if (s.startsWith("[") || s.includes("::")) { dropped.push(raw); continue; } // unbracketed IPv6 is ambiguous
      const port = /:(\d+)$/.exec(s);
      if (port) {
        if (Number(port[1]) > 65535) { dropped.push(raw); continue; }
        host = s.slice(0, -port[0].length);
      } else {
        if (s.includes(":")) { dropped.push(raw); continue; } // host:abc is not a host
        host = s;
      }
      host = host.replace(/^\.+/g, "");
      if (!host || host.includes("..")) { dropped.push(raw); continue; }
    }
    if (!/[a-z0-9]/i.test(host)) { dropped.push(raw); continue; } // punctuation alone ("-", ".") never matches
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { hosts, dropped };
}

/** The actionable helper-down message. Defined once here; content.js keeps a
 *  same-text const for its ping paths (see the mirror note on hostMatches). */
const HELPER_FIX = "helper not running — start it: node server/server.mjs";

/** Pick the panel's error status for a failed search. Pure: every branch is
 *  unit-tested in extension/shared.test.mjs.
 *  st = { isDirectMode, hasHealth, pingFailed } as tracked by the panel ping.
 *  Direct mode has no helper to blame; without any health signal we must not
 *  guess one (neutral); otherwise the helper copy is the actionable one. */
function searchErrorStatus(st, message) {
  const detail = typeof message === "string" && message.trim() ? message.trim() : "unknown error";
  const timedOut = /timeout/i.test(message ?? "");
  if (st.isDirectMode) return timedOut ? `search timed out — ${detail}` : `search failed — ${detail}`;
  if (st.hasHealth || st.pingFailed) {
    return timedOut ? "search timed out — is the helper healthy?" : HELPER_FIX;
  }
  return timedOut ? `search timed out — ${detail}` : `search failed — ${detail}`;
}

/** True when a keydown target is an editable field (inputs, textareas, selects,
 *  rich-text / code editors). The panel's Ctrl/Cmd+F hijack must stand down
 *  there — stealing the keystroke would break find-in-editor and Docs-style
 *  shortcuts. Reads only plain properties so it unit-tests with fake objects. */
function isEditableTarget(t) {
  if (!t || typeof t !== "object") return false;
  if (t.isContentEditable) return true; // Docs, Notion, CodeMirror 6, rich text
  const tag = typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Resolve a hit's highlight position inside its block text. A verified offset
 *  wins; otherwise the sentence is used only when it occurs exactly once —
 *  jumping to the first of several repeats would mark the wrong sentence as
 *  the answer. Returns the char offset or -1 (the caller shows no highlight
 *  rather than a wrong one). Pure: unit-tested in extension/p2.test.mjs. */
function resolveOffset(blockText, offset, sentence) {
  const text = typeof blockText === "string" ? blockText : "";
  const s = typeof sentence === "string" ? sentence : "";
  if (!s) return -1;
  if (Number.isFinite(offset) && text.slice(offset, offset + s.length) === s) return offset;
  const first = text.indexOf(s);
  if (first < 0) return -1;
  return text.indexOf(s, first + 1) === -1 ? first : -1;
}

globalThis.TrackyShared = { hostMatches, hostDenied, findSseBoundary, parseSseFrame, normalizeHosts, searchErrorStatus, HELPER_FIX, isEditableTarget, resolveOffset };
