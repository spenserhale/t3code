# Jira

Work through Jira Cloud issues the way you work through pull requests: list them, start a thread
from one, see its status next to the thread, move it along, and report back.

## Connect

Open **Settings → Source control → Jira** and enter your site (`https://your-team.atlassian.net`),
your Atlassian email, and an API token created without scopes at
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens). T3 Code checks them
with Jira before saving. The token stays on that environment's server and is never shown again.
**Disconnect** removes it.

Each environment has its own Jira connection. **Jira** appears in the sidebar once one of your
environments has it set up. The Jira page reads from the primary environment if Jira is set up
there, otherwise from the first environment that has it; with more than one, a menu in the page
header switches between them.

## The Jira page

Pick a view: issues assigned to you, your current sprint, issues you reported, recently updated
issues, or your own JQL query. Narrow it by project, by status category, or with text; pasting an
issue key such as `PROJ-123` finds that issue. Issues are grouped by status category, and each row
shows how many threads are linked to it. **Show more** loads the next page.

Select an issue to read its description and comments, move it with the status menu, comment on it,
open it in Jira, or copy its key.

## Threads and issues

A thread is linked to an issue when its title or its branch name contains the issue key, and the key
belongs to a project on your Jira site. Nothing else is stored, so `GPT-4` or `UTF-8` never match.

- **Start thread** opens a new thread in a project you choose (the one you used last for that Jira
  project is preselected), with the key, summary, link, and description in the composer. Turn on
  **New worktree** to work on a branch named after the key, such as
  `PROJ-123-fix-login-redirect`. Once the first message has been sent, the thread is titled
  `PROJ-123: Fix login redirect`.
- **Link thread** puts the key at the front of an existing thread's title. The unlink button next to a
  linked thread takes it off again.
- Linked threads show a chip with the issue key and status in the sidebar and above the composer.
  Its menu opens the issue, adds a comment, opens Jira, or copies the key.
- **Add comment** starts from the thread's title and its pull request links. Edit it before it is
  sent; web addresses become links.

To move an issue automatically when a thread starts from it, turn on **Move the issue when a thread
starts** in the same settings section and name the status. It is off by default, and the move only
happens when Jira offers it from the issue's current status.

## Limits

Jira Cloud only; Data Center and Server are not supported. The Jira page is on web and desktop, not
mobile. Statuses and lists can be a minute or two behind Jira.
