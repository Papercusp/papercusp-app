/** Minimal posix-style path join — dep-free (no node:path import). */
export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .map((p, i) => {
      let s = p;
      if (i > 0) s = s.replace(/^\/+/, '');
      if (i < parts.length - 1) s = s.replace(/\/+$/, '');
      return s;
    })
    .join('/');
}
