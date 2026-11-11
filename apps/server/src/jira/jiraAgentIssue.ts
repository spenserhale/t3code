/**
 * The issue as an agent reads it: the fields the Jira page shows, but with a bounded amount of
 * text, so one call cannot return every comment of a busy issue in full.
 *
 * @module jiraAgentIssue
 */
import { JiraComment, JiraIssueDetail } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const JIRA_AGENT_DEFAULT_COMMENTS = 10;
export const JIRA_AGENT_MAX_COMMENTS = 50;
export const JIRA_AGENT_DEFAULT_MAX_CHARS = 4_000;
export const JIRA_AGENT_MAX_CHARS = 8_000;
/** The description keeps this many times the characters of a comment or a criterion. */
export const JIRA_AGENT_DESCRIPTION_FACTOR = 3;
/** All comments together keep this many times the cap of one, however many are asked for. */
const COMMENT_TEXT_FACTOR = 10;

const Truncated = Schema.optionalKey(Schema.Literal(true));

const AgentComment = Schema.Struct({ ...JiraComment.fields, truncated: Truncated });

export const JiraAgentIssue = Schema.Struct({
  ...JiraIssueDetail.fields,
  acceptanceCriteria: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ name: Schema.String, markdown: Schema.String, truncated: Truncated }),
    ),
  ),
  comments: Schema.Array(AgentComment),
  descriptionTruncated: Truncated,
  /** What was left out and how to ask for more; absent when nothing was. */
  note: Schema.optionalKey(Schema.String),
});
export type JiraAgentIssue = typeof JiraAgentIssue.Type;

export interface JiraAgentIssueOptions {
  readonly comments?: number | undefined;
  readonly maxChars?: number | undefined;
}

const flag = (truncated: boolean) => (truncated ? { truncated: true as const } : {});

function cut(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, limit);
  const last = head.charCodeAt(head.length - 1);
  // Half a surrogate pair is not a character.
  return { text: last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head, truncated: true };
}

const count = (amount: number, one: string, many: string) =>
  `${amount} ${amount === 1 ? one : many}`;

/**
 * The newest `comments` comments (oldest first, as the page lists them) with every text cut to
 * `maxChars`, the description to a multiple of it. `commentCount` stays the issue's total.
 */
export function shapeIssueForAgent(
  issue: JiraIssueDetail,
  options: JiraAgentIssueOptions = {},
): JiraAgentIssue {
  const limit = Math.min(
    Math.max(options.maxChars ?? JIRA_AGENT_DEFAULT_MAX_CHARS, 1),
    JIRA_AGENT_MAX_CHARS,
  );
  const wanted = Math.min(
    Math.max(options.comments ?? JIRA_AGENT_DEFAULT_COMMENTS, 0),
    JIRA_AGENT_MAX_COMMENTS,
  );

  const description = cut(issue.descriptionMarkdown, limit * JIRA_AGENT_DESCRIPTION_FACTOR);
  const criteria = issue.acceptanceCriteria?.map((field) => {
    const body = cut(field.markdown, limit);
    return { name: field.name, markdown: body.text, ...flag(body.truncated) };
  });

  // Newest first until the comment text is used up; the newest always fits, being cut to `limit`.
  let room = limit * COMMENT_TEXT_FACTOR;
  const newestFirst: Array<typeof AgentComment.Type> = [];
  for (const comment of issue.comments.toReversed().slice(0, wanted)) {
    const body = cut(comment.bodyMarkdown, limit);
    if (body.text.length > room) break;
    room -= body.text.length;
    newestFirst.push({ ...comment, bodyMarkdown: body.text, ...flag(body.truncated) });
  }
  const comments = newestFirst.toReversed();

  const notShown = issue.commentCount - comments.length;
  const older = comments.length > 0 ? "older " : "";
  const cutBodies = comments.filter((comment) => comment.truncated).length;
  const cutCriteria = criteria?.filter((field) => field.truncated).length ?? 0;
  const cutShort = [
    ...(description.truncated ? ["the description"] : []),
    ...(cutBodies > 0 ? [count(cutBodies, "comment body", "comment bodies")] : []),
    ...(cutCriteria > 0 ? [count(cutCriteria, "acceptance criterion", "acceptance criteria")] : []),
  ];
  const note = [
    ...(notShown > 0
      ? [`Not shown: ${count(notShown, `${older}comment`, `${older}comments`)}.`]
      : []),
    ...(cutShort.length > 0 ? [`Cut short: ${cutShort.join(", ")}.`] : []),
    ...(comments.length < issue.comments.length || cutShort.length > 0
      ? ["Pass `comments` or `maxChars` for more."]
      : []),
  ].join(" ");

  return {
    ...issue,
    descriptionMarkdown: description.text,
    ...(criteria === undefined ? {} : { acceptanceCriteria: criteria }),
    comments,
    ...(description.truncated ? { descriptionTruncated: true as const } : {}),
    ...(note.length > 0 ? { note } : {}),
  };
}
