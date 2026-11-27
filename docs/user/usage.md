# Usage and limits

Track token usage, cache hit rates, estimated API-equivalent costs, and pooled subscription quotas across all connected environments.

- **Open Usage**: Click **Usage** in the sidebar, press `mod+u` (web/desktop outside terminals), or pick **Usage** on mobile.
- **Quick shortcuts** (web/desktop on Usage): `C` (Cost), `T` (Tokens), `L` (Limits), `mod+Shift+1/2/3/4` (24h / 7d / 30d / 90d), `Esc` (back).

## Understand your usage

Usage aggregates history across Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor from your selected environments. Estimates reflect API-equivalent rates (not your subscription bill); **Premium** shows Fast/Ultrafast surcharge, and **Other** shows unsplit provider-reported costs.

- **Retention**: Servers keep scanned usage history for **92 days** by default (preserving Claude history after Claude's 30-day cleanup). Change `usageHistoryRetentionDays` in `<t3-home>/userdata/settings.json` (e.g. `365` or `"unlimited"`; views show up to 90 days).
- **Custom data directories**: Honors `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, `OPENCODE_DATA_DIR`, `ANTIGRAVITY_DATA_DIR`, and `XDG_DATA_HOME` (Muse). Use absolute or `~/` paths. Set `T3CODE_HOST_ID` to pin a container's host identity.
- **Exclusions**: Codex and Claude Code 2.0.63+ text-generation runs (titles, commits, PR text, review guides) and Grok turns without a saved completed-turn record are not included.
- **Ollama Cloud prices**: OpenCode's Ollama Cloud models appear as `ollama-cloud/<model>`, priced at the median of OpenRouter's zero-data-retention endpoints for the same model, because a flat Ollama plan has no per-token price.

## See usage per thread and turn

Turn on **Settings → Chat → Usage and cost** to see tokens and estimated cost where you work.
It is off by default. The token count is marked with a hexagon, the way `$` marks dollars:

- A turn's "Worked for" summary adds what it used, for example `Worked for 5m 33s using ⬡ 264K,
  $0.14*`. Hover it to see each model's share and where its price came from. Short answers that
  show no "Worked for" summary show no usage either.
- Hovering a thread in the sidebar shows its total, and how long the agent worked on it: the time
  of each finished turn added up, without the time it sat waiting for you.
- **Usage** gains a **Thread** breakdown. Select a column heading to sort by it.

The asterisk marks an estimate at API prices. If you use a subscription, your bill is different.

Thread figures count the main agent's work in turns you ran through T3 Code. They are lower than
the model breakdown, which also includes subagents and work done directly in the provider's own
tools. Claude, Codex, and OpenCode threads report them; other providers' threads show none, and
neither do turns from before T3 Code kept usage per turn.

Turns are priced with the same rates as the rest of Usage, including your custom model prices and
model mappings. A price you add later applies to past turns too. A model with no known price shows
its tokens but no cost until you add one. Fast and Ultrafast turns are estimated at standard rates.
Models run through Unlid are priced at Unlid's published rates when no other price is known; a
custom price still wins.

A turn is priced under the model you selected for it. A provider's history sometimes records a
longer ID for the same model, such as one ending in a date, and **Usage** lists that one. A custom
price entered for the longer ID then does not reach the turn. Map the model you selected to it
with **Map to** under **Model prices**, and both use the same price.

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
- **Provider notes**:
  - **OpenCode**: OpenCode 2 servers with usage reporting show Go allowances and Console budgets for the connected workspace. Local servers can also report Go usage from a Go API key (`OPENCODE_API_KEY`). A Z.ai Coding Plan signed in through OpenCode reports its 5-hour and weekly quota, its monthly tool allowance, and banked quota resets; **Use reset** spends the 5-hour reset, or the weekly one when that is the only kind banked or the weekly quota is the fuller of the two, because a weekly reset also clears the 5-hour quota. An Ollama Cloud subscription signed in through OpenCode reports its monthly credit, or its session and weekly usage on older plans, each with its reset time. Under a monthly credit, Limits also shows how much of the pool the period has used, what the plan costs, and any purchased credit. On a $60 Pro or $300 Max plan, when at least half of that usage was on models OpenRouter prices, it also shows what the usage would have cost at OpenRouter's zero-data-retention rates. Team and custom-sized pools skip that, because their balance can include other members' usage. An Unlid account — pay-as-you-go — shows its balance on Limits: what is left, what is held by open reservations, and what this month has spent. It has no reset and no usage chart; top up at Unlid's billing page. Each subscription signed in through OpenCode is its own account and counts once across your environments, whatever else each environment is signed in to, once every environment's server is up to date. OpenCode Go and Console spend limits are matched by their Console workspace, and Z.ai and Ollama Cloud by their API key. OpenCode Go counts twice when one environment reads it through a Go API key and another through the Console workspace.
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
