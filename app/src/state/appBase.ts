/**
 * Absolute URL of the app's own directory.
 *
 * The app is built with a relative base so it can be served from any path,
 * which means `import.meta.env.BASE_URL` is `./`. Resolving that against
 * `window.location.href` is only right when the page URL ends in a slash or a
 * filename: a host that serves the app at an extensionless URL would send
 * every data fetch one directory too high, with no way to tell from the
 * location alone which reading was meant.
 *
 * In a built app the answer is not a guess. Every bundle lands flat in
 * `assets/`, so this module's own URL is `<root>/assets/<chunk>.js` and the
 * root is one level above it, whatever path the host serves the page at. The
 * dev server has no bundle and always serves from the origin root, so that
 * case falls back to the location.
 */
export function appBaseUrl(): string {
  if (import.meta.env.DEV) {
    return new URL(import.meta.env.BASE_URL, window.location.href).href;
  }
  return new URL('../', import.meta.url).href;
}

/** Absolute URL of the app's `data/` directory, safe to hand to a worker. */
export function dataBaseUrl(): string {
  return new URL('data', appBaseUrl()).href;
}
