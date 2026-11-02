const MAX_DESCRIPTION_LENGTH = 6_000;

/** What a thread started from an issue opens with. The person reads it over before sending. */
export function issueThreadPrompt(issue: {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  readonly descriptionMarkdown: string;
}): string {
  const description = issue.descriptionMarkdown.trim();
  const shown =
    description.length > MAX_DESCRIPTION_LENGTH
      ? `${description.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()}\n\n[Description cut short. The rest is on the issue.]`
      : description;
  return [
    `Work on Jira issue ${issue.key}: ${issue.summary.trim()}`,
    issue.url,
    ...(shown.length === 0 ? [] : [`Description:\n\n${shown}`]),
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
