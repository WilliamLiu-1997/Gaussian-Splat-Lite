/** Response URLs such as blob: and data: cannot resolve relative assets. */
export function getAssetBaseUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    new URL(".", url);
    return url;
  } catch {
    return undefined;
  }
}
