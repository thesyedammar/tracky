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
