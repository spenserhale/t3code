// A key is a project key, a hyphen and a number, and is not part of a longer word.
const TITLE_KEY_PATTERN =
  /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{1,24}-[1-9][0-9]{0,9})(?![A-Za-z0-9_])/gu;
// Branch names are often lower case, so a branch may spell the key either way.
const BRANCH_KEY_PATTERN =
  /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]{1,24}-[1-9][0-9]{0,9})(?![A-Za-z0-9_])/gu;

const MAX_TITLE_LENGTH = 120;

export const issueProjectKey = (issueKey: string): string =>
  issueKey.slice(0, issueKey.lastIndexOf("-"));

/**
 * The issues a thread belongs to: every key in its title or branch name whose
 * project exists on the Jira site. Text such as `GPT-4` or `UTF-8` only counts
 * if the site really has a project by that name, and a title needs the key in
 * capitals, as people write it.
 */
export function extractIssueKeys(
  thread: { readonly title: string; readonly branch: string | null },
  projectKeys: ReadonlySet<string>,
): ReadonlyArray<string> {
  if (projectKeys.size === 0) return [];
  const keys: string[] = [];
  const consider = (match: RegExpMatchArray) => {
    const key = match[1]!.toUpperCase();
    if (projectKeys.has(issueProjectKey(key)) && !keys.includes(key)) keys.push(key);
  };
  for (const match of thread.title.matchAll(TITLE_KEY_PATTERN)) consider(match);
  if (thread.branch !== null) {
    for (const match of thread.branch.matchAll(BRANCH_KEY_PATTERN)) consider(match);
  }
  return keys;
}

const truncate = (text: string, length: number) =>
  text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;

/** `KEY: summary`, the title a thread started from an issue ends up with. */
export const issueThreadTitle = (issueKey: string, summary: string): string =>
  truncate(`${issueKey}: ${summary.replace(/\s+/gu, " ").trim()}`.trimEnd(), MAX_TITLE_LENGTH);

/** The title with `KEY: ` in front, unless it already names the key. */
export function linkedThreadTitle(title: string, issueKey: string): string {
  const trimmed = title.trim();
  if (new RegExp(`(?<![A-Za-z0-9_])${issueKey}(?![A-Za-z0-9_])`, "u").test(trimmed)) return trimmed;
  return truncate(`${issueKey}: ${trimmed}`, MAX_TITLE_LENGTH);
}

/** The title without a leading `KEY:` or `KEY -`, or `null` when it does not start that way. */
export function unlinkedThreadTitle(title: string, issueKey: string): string | null {
  const trimmed = title.trim();
  for (const separator of [":", " -", " –"]) {
    const prefix = `${issueKey}${separator}`;
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
      const rest = trimmed.slice(prefix.length).trim();
      if (rest.length > 0) return rest;
    }
  }
  return null;
}

const SLUG_WORDS = 6;
const SLUG_LENGTH = 40;

/** `PROJ-123-fix-login-redirect`: the key, then the first words of the summary. */
export function issueBranchName(issueKey: string, summary: string): string {
  const slug = summary
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0)
    .slice(0, SLUG_WORDS)
    .join("-")
    .slice(0, SLUG_LENGTH)
    .replace(/-+$/u, "");
  return slug.length === 0 ? issueKey : `${issueKey}-${slug}`;
}

/** The name unchanged unless a branch already has it, then `-2`, `-3` and so on. */
export function unusedBranchName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
