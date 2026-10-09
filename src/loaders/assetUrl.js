/** Response URLs such as blob: and data: cannot resolve relative assets. */
export function getAssetBaseUrl(url) {
  if (!url) return undefined;
  try {
    new URL(".", url);
    return url;
  } catch {
    return undefined;
  }
}
