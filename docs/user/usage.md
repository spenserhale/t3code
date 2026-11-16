# Usage and limits

Track token usage, cache hit rates, estimated API-equivalent costs, and pooled subscription quotas across all connected environments.

- **Open Usage**: Click **Usage** in the sidebar, press `mod+u` (web/desktop outside terminals), or pick **Usage** on mobile.
- **Quick shortcuts** (web/desktop on Usage): `C` (Cost), `T` (Tokens), `L` (Limits), `mod+Shift+1/2/3/4` (24h / 7d / 30d / 90d), `Esc` (back).

## Understand your usage

Usage aggregates history across Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor from your selected environments. Estimates reflect API-equivalent rates (not your subscription bill); **Premium** shows Fast/Ultrafast surcharge, and **Other** shows unsplit provider-reported costs.

- **Retention**: Servers keep scanned usage history for **92 days** by default (preserving Claude history after Claude's 30-day cleanup). Change `usageHistoryRetentionDays` in `<t3-home>/userdata/settings.json` (e.g. `365` or `"unlimited"`; views show up to 90 days).
- **Custom data directories**: Honors `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, `OPENCODE_DATA_DIR`, `ANTIGRAVITY_DATA_DIR`, and `XDG_DATA_HOME` (Muse). Use absolute or `~/` paths. Set `T3CODE_HOST_ID` to pin a container's host identity.
- **Exclusions**: Codex and Claude Code 2.0.63+ text-generation runs (titles, commits, PR text, review guides) and Grok turns without a saved completed-turn record are not included.

## Custom model prices and filtering

- **Custom prices & model mapping**: Open the environment dropdown on **Usage → Model prices** (or click **Set price** on an unpriced model) to set USD per million input/output/cache tokens, or set **Map to** to merge a preview/alias model ID into a target model's totals.
- **Filter models**: Add `usageModelFilter` to `<t3-home>/userdata/settings.json` (applied before **Map to**):

```json
{
  "usageModelFilter": {
    "include": [{ "provider": "claude", "model": "orbit-1" }, { "model": "orbit-2" }],
    "exclude": [{ "model": "drift-9" }]
  }
}
```

## Subscription limits

**Usage → Limits** pools subscription quotas per provider across connected environments and hubs (deduplicating the same account signed in on multiple machines).

- **In chat**: Run `/usage-limits` in the composer to view the current model's snapshot without running the agent, or enable **Settings → Appearance → Thread details → Usage limits** (web/desktop).
- **Reset credits**: Click an account segment/row to inspect plan details and redeem banked Codex/Claude reset credits via **Use reset** (Claude resets unavailable on macOS Keychain logins).
- **Groups** (web/desktop): Choose **Groups** on Limits and turn on **Group accounts on Limits** to keep subscriptions that are not interchangeable apart, such as personal and work accounts. Each group gets its own section and pools only its own accounts. Accounts that share an email are grouped together across providers; type a name next to an account to put it in a group of your own, or clear it to return the account to its email. Naming a group turns grouping on. Groups are saved on the device where you set them.
- **Schedules** (web/desktop): A subscription you use only some days, such as a work account, can have a schedule. In **Groups**, choose when each group is used: every day, Monday to Friday, Monday to Friday between 9 and 5, or your own days, hours and time zone. Hours may run overnight, from an evening into the next morning (an end earlier than the start), and belong to the day they begin on. An account that differs can have its own schedule. Pace and the burn-down then count only the scheduled time, so a work account is not shown as behind on a Sunday. Schedules are saved on the device where you set them and apply whether or not grouping is on.
- **Pace** (web/desktop): While Reminders are on, or a Burn-down is open, T3 Code reads the last 90 days of token totals from each connected environment in the background, and learns your usual pattern from them once a provider has two weeks of use (all of a provider's accounts count together). An environment that cannot be reached is asked again later while the others keep their totals. Pace is judged against that pattern, so a heavy Monday is not "ahead", and against even spending until the pattern is known. It reads as how far in reserve or in deficit an account is, what share the pattern would have used by now, and whether the window lasts until the reset or runs out. It is left out for the first few percent of a window. If a reset credit empties a window early, pace and the forecasts count from then.
- **Burn-down** (web/desktop): Each session, weekly and monthly window has a **Burn-down** below its bar. It charts what was left over the window against the pace line, forecasts where the window ends, shows how many points of the window each day used against what the line allows that day, and how much of your last windows you used. Choose the forecast: the run rate so far, the weekday pattern, or your recent trend. T3 Code records readings while it is open, so the history starts when you first open it and has gaps while the app is closed; days it was closed for are estimated from the readings either side.
- **Reminders** (web/desktop): Choose **Reminders** to be nudged when a subscription is about to reset with allowance to spare: a weekly window within a day of its reset, or a monthly one within three days, with at least a quarter of it left and the forecast saying that much will go unused, during the days and hours its schedule says it is used. A window that cannot be forecast yet is left out until it can. One notice lists every window that qualifies, soonest reset first, and mentions each window once per reset. Choose when it comes (as windows come up, once a day for each group, in the app only, or off), how much left triggers it, and whether 5-hour session windows count. Reminders follow your notification settings and permission, and arrive only while T3 Code is open. The same windows are listed as **Use today** at the top of Limits. The sidebar's Usage button shows a dot while there are any.
- **Quick look** (web/desktop): Hover over or tab to **Usage** in the sidebar to see what is left without opening the page. Accounts are ordered by their next known reset within your groups. Each consumption pool keeps its own row, with short and weekly windows side by side and monthly allowances labeled separately. Bars show the percentage left; the tick marks expected remaining allowance by now, not a forecast of what will remain at reset. Early-exhaustion warnings identify windows that may run out before they refresh. A dash beside the reset icon means the window has not started or its reset time is unavailable; a countdown appears when a reset time is reported. Monthly allowances read **Monthly** here; credit amounts, Claude's spending budget, and Z.ai's non-AI Tools allowance stay in the detailed Limits page. The summary does not start a new check, so an account whose limits have reset since its last reading shows as reset until the next check. Antigravity's Quick View focuses on its primary Gemini allowance; Argon and shared Claude/GPT limits remain in Details.
- **Provider notes**:
  - **OpenCode**: OpenCode 2 servers with usage reporting show Go allowances and Console budgets for the connected workspace. Local servers can also report Go usage from a Go API key (`OPENCODE_API_KEY`).
  - **Cursor**: Reports monthly Auto + API quotas via `CURSOR_AUTH_TOKEN` or default-endpoint sign-in/`CURSOR_API_KEY`.
  - **Grok**: Reports billing-period quotas for `grok login` (not `XAI_API_KEY`).
  - **Muse Code**: Reports session/weekly limits after running in a thread (not persisted across restarts).
  - Pure API-key accounts generally do not report subscription limits.
- **Mobile widget**: Add the **Subscription usage** widget on iOS or Android to monitor Codex and Claude quotas from your home screen.

## Connect a CLIProxyAPI hub

Open **Settings → Providers → Usage providers → Add hub**, choose the environment, and enter the hub URL and management key. Pools Codex, Claude, and Grok accounts under **Usage → Limits** (including Codex **Use reset**). Configure the provider's endpoint to the same URL if you want threads to display that hub's limits.

## Connect an HTTP quota source

Open **Settings → Providers → Usage providers → Add HTTP source** with a GET endpoint (and optional bearer token) returning:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "primary",
      "label": "My coding plan",
      "providerInstanceId": "work-codex",
      "windows": [
        {
          "id": "monthly",
          "kind": "monthly",
          "label": "Monthly budget",
          "usedPercent": 35,
          "resetsAt": "2026-12-01T00:00:00Z"
        }
      ]
    }
  ]
}
```

`kind` is `session`, `weekly`, `monthly`, or `other`. Setting `providerInstanceId` binds the quota windows to that instance's thread details card.
