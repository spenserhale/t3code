# Jira

Work through Jira Cloud issues the way you work through pull requests: list them, start a thread
from one, see its status next to the thread, move it along, and report back.

## Connect

Open **Settings → Source control → Jira** and enter your site (`https://your-team.atlassian.net`),
your Atlassian email, and an API token created without scopes at
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens). T3 Code checks them
with Jira before saving. The token stays on that environment's server and is never shown again.
**Disconnect** removes it, and stays available when Jira has stopped accepting the saved token, so an
expired one can be replaced or removed. A check that fails is shown even if an earlier one had
worked.

Each environment has its own Jira connection. **Jira** appears in the sidebar once one of your
environments has it set up. The Jira page reads from the primary environment if Jira is set up
there, otherwise from the first environment that has it; with more than one, a menu in the page
header switches between them. A thread's issue key is looked up on its own environment's Jira site
when that has Jira, otherwise on the only environment that does. With several to choose from and
none of them the thread's own, the thread shows no chip rather than one from the wrong site.

## The Jira page

Pick a view: issues assigned to you, your current sprint, issues you reported, recently updated
issues, or your own JQL query. Narrow it by project, by status category, or with text; pasting an
issue key such as `PROJ-123` finds that issue. **Sort** orders the list by last update, newest,
priority or key; it replaces the view's own order, including the `ORDER BY` of your JQL. Issues are
grouped by status category, and each row shows how many threads are linked to it. **Show more**
loads the next page.

Opening Jira from the sidebar returns to the filters and sort you last used. The list and the open
issue refresh about every minute while the page is in view, as do the status chips of linked
threads anywhere in the app; neither refreshes while the window is hidden. The refresh button asks
Jira itself rather than the server's short memory of it. **Escape** closes the open issue, and then
leaves the page. While you are typing in a field, it only lets go of the field.

Select an issue to read its description, its acceptance criteria and its comments, move it with the
status menu, comment on it, open it in Jira, or copy its key. Acceptance criteria are shown when
your site has a custom field named like "Acceptance criteria"; they go into the composer with the
description when you start a thread.

## Threads and issues

A thread is linked to an issue when its title or its branch name contains the issue key, and the key
belongs to a project on your Jira site. Nothing else is stored, so `GPT-4` or `UTF-8` never match.
A thread without a worktree is linked only through its title, an automatic title refresh can drop
the key, and **Link thread** restores it.

- **Work on issue** opens a new thread in a project you choose (the one you used last for that Jira
  project is preselected), with the key, summary, link, description and acceptance criteria in the
  composer. Only projects whose environment reads this issue's Jira site are offered: with two
  environments that each have their own Jira, a project on the other one would show `PROJ-1` as
  that site's issue. **New worktree** is on whenever the project is a Git repository, so the work
  happens on a branch named after the key, such as `PROJ-123-fix-login-redirect`, or the next free
  `PROJ-123-fix-login-redirect-2` when the repository or another thread already has that name. Start
  waits until the project has been checked; if the check fails, turn **New worktree** off to start
  without one. Once the first message has been sent, the thread is titled
  `PROJ-123: Fix login redirect`; if that cannot be done at once it is tried again.
- **Ask about issue** opens a thread in your project's own checkout with the issue in the composer
  and room for your question; the thread is asked to answer without changing code. Like the other
  threads started here, it is titled with the issue once its first message has been sent.
- **Plan issue** opens a thread in plan mode, in a new worktree like **Work on issue**, with the
  issue and a request for a plan.
- Sending the same draft to several models at once starts one thread per model. Each gets the same
  title, and when the draft had a worktree each gets its own branch, checked against the
  repository as for a single thread: `PROJ-123-fix-login-redirect`, then `-2`, `-3` and so on. A
  model that is sent again after failing keeps the name it had, and never takes a branch another
  model's thread now holds.
- **Link thread** puts the key at the front of an existing thread's title. It lists the threads you
  can change, and with several Jira sites only those that use this one. The unlink button next to a
  linked thread takes it off again, and is unavailable where you cannot change threads.
- Linked threads show a chip with the issue key and status in the sidebar, above the composer and in
  the thread's details panel. Its menu opens the issue, adds a comment, opens Jira, or copies the
  key.
- **Add comment** starts from the thread's title and its pull request links. Edit it before it is
  sent; web addresses become links.

To move an issue automatically when a thread starts from it, turn on **Move the issue when a thread
starts** in the same settings section and name the status. It is off by default, and the move only
happens when Jira offers it from the issue's current status.

## Agents

Agents use the Jira connection of the environment they work in, [outside agents](./outside-agents.md)
included. They can search for issues, read one with its description, acceptance criteria and
comments, list the moves Jira offers from its status and make one, and add a comment
(`jira_issue_search`, `jira_issue_read`, `jira_issue_transition` and `jira_issue_comment`). Moves
and comments are made as the connected Jira account, so they appear under your name. An outside
agent with **Read only** access can search and read, but not move or comment.

An agent links a thread to an issue the way you do: by putting the key in capitals in the thread's
title, as in `PROJ-123: Fix login redirect`. As for any thread, an automatic title refresh can drop
the key from a thread without a worktree (see [Threads and issues](#threads-and-issues)).

## Limits

Jira Cloud only; Data Center and Server are not supported. The Jira page is on web and desktop, not
mobile. Statuses and lists can be a minute or two behind Jira, and Jira's own search can trail an
edit by a few seconds. Bulk actions and tabbed issue details are not available.
