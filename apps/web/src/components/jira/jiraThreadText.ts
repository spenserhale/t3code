const MAX_DESCRIPTION_LENGTH = 6_000;
const MAX_CRITERIA_LENGTH = 4_000;

interface PromptIssue {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  readonly descriptionMarkdown: string;
  readonly acceptanceCriteria?:
    | ReadonlyArray<{ readonly name: string; readonly markdown: string }>
    | undefined;
}

function bounded(text: string, limit: number, label: string): string {
  const trimmed = text.trim();
  return trimmed.length > limit
    ? `${trimmed.slice(0, limit).trimEnd()}\n\n[${label} cut short. The rest is on the issue.]`
    : trimmed;
}

/** The description, then each acceptance criteria field under the name the site gives it. */
function issueSections(issue: PromptIssue): ReadonlyArray<string> {
  const description = bounded(issue.descriptionMarkdown, MAX_DESCRIPTION_LENGTH, "Description");
  return [
    ...(description.length === 0 ? [] : [`Description:\n\n${description}`]),
    ...(issue.acceptanceCriteria ?? []).flatMap((field) => {
      const text = bounded(field.markdown, MAX_CRITERIA_LENGTH, field.name);
      return text.length === 0 ? [] : [`${field.name}:\n\n${text}`];
    }),
  ];
}

/** What a thread started from an issue opens with. The person reads it over before sending. */
export function issueThreadPrompt(issue: PromptIssue): string {
  return [
    `Work on Jira issue ${issue.key}: ${issue.summary.trim()}`,
    issue.url,
    ...issueSections(issue),
    "",
  ].join("\n\n");
}

/** The issue for a question about it, which is answered from the code without changing any. */
export function issueAskPrompt(issue: PromptIssue): string {
  return [
    `Question about Jira issue ${issue.key}: ${issue.summary.trim()}`,
    issue.url,
    ...issueSections(issue),
    "Answer my question below. Do not change any code, and do not check anything out unless asked to.",
    "My question:",
    "",
  ].join("\n\n");
}

/** The issue for a plan, which the thread writes in plan mode before anything is changed. */
export function issuePlanPrompt(issue: PromptIssue): string {
  return [
    `Plan the work for Jira issue ${issue.key}: ${issue.summary.trim()}`,
    issue.url,
    ...issueSections(issue),
    "Read the code and write a plan for doing this. Do not change any code yet.",
    "",
  ].join("\n\n");
}

/**
 * The comment a person starts from when reporting back: each thread's title,
 * with the pull requests it opened. They edit it before it goes to Jira.
 */
export function issueCommentDraft(
  threads: ReadonlyArray<{
    readonly title: string;
    readonly pullRequestUrls: ReadonlyArray<string>;
  }>,
): string {
  return threads
    .map((thread) =>
      [thread.title.trim(), ...thread.pullRequestUrls.map((url) => `Pull request: ${url}`)].join(
        "\n",
      ),
    )
    .join("\n\n");
}
