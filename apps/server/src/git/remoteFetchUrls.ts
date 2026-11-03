/** The fetch URL of each remote in `git remote -v` output, by name. */
export function parseRemoteFetchUrls(stdout: string): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) urls.set(match[1], match[2]);
  }
  return urls;
}
