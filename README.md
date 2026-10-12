# skylight-mcp

## What it is

skylight-mcp is a local MCP server that lets an AI assistant such as Claude Desktop manage chores, routines, rewards, lists and calendar events on a Skylight Calendar. It runs on your Mac over stdio and talks to Skylight's web API.

This is an unofficial project. It is not affiliated with or endorsed by Skylight. It uses Skylight's private API, which is undocumented and can change or break at any time without notice. It runs on macOS only, because the login credential is stored with the macOS Keychain.

## Safety

- The tool set is narrow. There are no tools for accounts, devices, photos or meals. Never exposed: account delete or export, email or password change, frame transfer. Changed 2026-10-12 at Jordan's request: profiles (Skylight categories) can be created, updated and deleted; rewards, lists and calendar events (phase 2) can be created, changed and deleted. Every destructive action is confirm-gated.
- Calendar events synced from Google or another calendar are read-only here: `skylight_update_event` and `skylight_delete_event` refuse them (`source` other than `skylight`) before sending any request.
- Deleting a chore requires `confirm: true`. Without it, `skylight_delete_chore` changes nothing and returns a preview of what would be deleted.
- Deleting a reward, a list, list items or a calendar event works the same way: the delete tools need `confirm: true` and otherwise return a preview (reward and list details, the titles of the items, or the scope and a warning when a whole recurring series would go). Deleting a list deletes its items. A recurring event deleted by its plain id, or with `applyTo: "all"`, removes the whole series. `skylight_redeem_reward` spends points, so it is confirm-gated too and its preview shows the current balance.
- Deleting a profile works the same way: `skylight_delete_profile` needs `confirm: true`, and its preview shows the upcoming chore count and where chores and events would go. To retire a person without losing their events, use `skylight_update_profile` with `kind: "label"` (Skylight's "Convert to Label").
- Bulk create validates every item before sending any request, supports `dryRun: true`, and stops early if Skylight rejects the login or rate limits the requests.
- Tokens are stored encrypted with AES-256-GCM. The encryption key lives in the macOS Keychain. Any process running as your user can read that key through `/usr/bin/security` without a prompt, so the encryption protects backups and the file at rest, not against malware on the Mac.
- Tokens, codes and keys are never written to logs and never returned in tool results. `status` and `doctor` print no token values.
- The OAuth token Skylight issues has full-account scope. The tool layer here is narrow, but the token itself is not. Treat the stored credential as sensitive, and run `skylight-mcp logout` to remove it.

## Install

The package is named `@jordanlawson/skylight-mcp` but it is not published to npm. Install from source. Node 20 or newer is required.

```sh
git clone https://github.com/jordanlawson1988/skylight-mcp
cd skylight-mcp
npm install
npm run build
npm link
```

`npm link` makes the `skylight-mcp` command available on your PATH. Commands: `login`, `logout`, `status`, `doctor`. Without linking, `node dist/cli.js <command>` does the same thing.

## Login

```sh
skylight-mcp login
```

The command prints a link to Skylight's authorize page. Open it in Chrome and sign in. The page needs Skylight's own server-side sign-in, not the session from the Skylight web app, so you may be asked to sign in even if the web app is already open.

After sign-in, Skylight sends the browser to `https://ourskylight.com/welcome?code=...` and then immediately redirects to its home page, so you usually cannot copy the callback address from the address bar. That is fine. Go back to the terminal and press Enter. The CLI then looks in Chrome's local history for that one URL and finishes the login. If nothing is found yet, it says so and asks again: press Enter to check again, paste the callback address, or type `q` to quit. The pending login stays valid for 10 minutes across retries.

What that lookup does: it reads only history entries whose URL starts with `https://ourskylight.com/welcome?code=` and that were visited after the login started. It copies Chrome's `History` database to a private temp directory (mode 0700), queries the copy with the macOS `/usr/bin/sqlite3` in read-only mode, and deletes the copy afterwards. Nothing else in your history is read, and the URL is never printed or logged. This only works with Google Chrome.

If you would rather paste the address (or you use another browser), paste the full `https://ourskylight.com/welcome?code=...` address at the prompt instead of pressing Enter. If a login was started earlier and you have the final URL, run `skylight-mcp login --complete <url>` to finish it. `--pkce S256|plain` selects the PKCE method (default `S256`).

Check the result with `skylight-mcp status`. It shows whether you are logged in, the API host, the token expiry and the frame in use.

## Claude Desktop setup

```sh
skylight-mcp doctor
```

`doctor` prints your login status, the profiles it can see, and a ready-made config block with the absolute paths to your `node` binary and to `dist/server.js`. Paste that block into `~/Library/Application Support/Claude/claude_desktop_config.json`, merging it with any existing `mcpServers` entries, then restart Claude Desktop. It looks like this:

```json
{
  "mcpServers": {
    "skylight": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/skylight-mcp/dist/server.js"]
    }
  }
}
```

If your account has more than one frame, set `SKYLIGHT_FRAME_ID` in the `env` block of that entry. `doctor` includes it when it is set in your environment.

## Tools

| Tool | What it does |
| --- | --- |
| `skylight_auth_status` | Reports login state, API host, frame and token expiry. Never returns secrets. |
| `skylight_list_profiles` | Lists family profiles and their ids. Chores and points are assigned by profile id. |
| `skylight_create_profile` | Creates a profile (`kind: "profile"`, a person with a chore-chart column, the default) or a label (`kind: "label"`, a calendar category such as Birthdays). Needs `name` and a `#RRGGBB` `color`. |
| `skylight_update_profile` | Changes a profile's `name`, `color` or `kind`. Only the fields you pass change. `kind: "label"` is Skylight's "Convert to Label", the non-destructive way to retire a person; the profile keeps its events. |
| `skylight_delete_profile` | Deletes a profile or label. Returns a preview and changes nothing unless `confirm: true` is set. Optional `reassignToProfileId` moves its chores and events to another profile instead of deleting them. |
| `skylight_list_chores` | Lists chores and routine steps in a date range (default today through 14 days ahead), sorted by `instanceDate`, then `instanceTime`, `position` and summary. Overdue occurrences are only included with `includeLate: true` (default false; can be large). Up-for-grabs chores are included by default (`includeUpForGrabs` defaults to true). Recurring occurrences carry a `seriesId` and an `instanceDate`; ids of later occurrences look like `123-2026-10-13`, and routine-step occurrences like `123-2026-10-13-0600` (pass ids exactly as listed). |
| `skylight_create_chore` | Creates one chore or routine step for one or more profiles (people only; labels such as Birthdays are rejected). Routine steps need `routine: true` and `timeOfDay` (`morning`, `afternoon` or `evening`) and take no `startTime`. With `upForGrabs: true`, `start` and `profileIds` are optional, giving an unassigned chore anyone can claim. Also accepts `description`, `timerSeconds`, `rewardPoints` and `emoji`. Returns `{ created, ids }`, because Skylight makes one chore per assigned profile. |
| `skylight_bulk_create_chores` | Creates up to 50 chores in one call. Validates all items first and supports `dryRun: true`. |
| `skylight_update_chore` | Changes fields on an existing chore. Only the fields you pass change. Pass `null` for `startTime`, `emoji`, `rewardPoints`, `description`, `timerSeconds` or `recurrence` to clear them. Accepts `timeOfDay` for routine steps (with `routine: true`, or together with an explicit `recurrence`, because the hour is part of the schedule). Accepts plain or composite ids (the series id is used). `applyTo` accepts only `"all"`; per-occurrence scopes are not available for update. |
| `skylight_delete_chore` | Deletes a chore. Returns a preview and changes nothing unless `confirm: true` is set. One-time chore: omit `applyTo`. Recurring chore: `applyTo: "all"` deletes the whole series, `"future"` deletes the given occurrence and all later ones, `"one"` deletes only that occurrence. Routine steps can only be deleted as a whole series (`"all"`); `"one"` and `"future"` are for regular recurring chores. `"one"` and `"future"` need the occurrence date: pass a composite id such as `123-2026-10-13`, or the plain id plus `instanceDate`. |
| `skylight_complete_chore` | Marks a chore done, or reverts it with `done: false`. Recurring chores need the occurrence date (a composite id like `123-2026-10-13`, or `instanceDate`); one-time chores must omit it. `profileId` is optional and only for up-for-grabs chores. |
| `skylight_get_reward_points` | Shows the point balance per profile as `{ profileId, name, kind, points, lifetimePoints }`. Labels such as Birthdays are included with `kind: "label"`. |
| `skylight_add_reward_points` | Adds or subtracts points for one or more profiles. Negative values subtract. |
| `skylight_list_rewards` | Lists the rewards as `{ id, title, cost, emoji, description, respawnOnRedemption, redeemedAt, redeemed, profileId }`. Unredeemed rewards only, unless `includeRedeemed: true`. |
| `skylight_create_reward` | Creates a reward for one or more people (`title`, `cost` 1-100000, `profileIds`; labels are rejected). Skylight makes one reward per profile. Optional `emoji`, `description` and `respawnOnRedemption` (default true). |
| `skylight_update_reward` | Changes a reward's `title`, `cost`, `emoji`, `description`, `respawnOnRedemption` or owning `profileId`. Only the fields you pass change. |
| `skylight_redeem_reward` | Spends the profile's points on a reward. Returns a preview (cost, current points, whether the balance covers it) and changes nothing unless `confirm: true`. Not idempotent. A reward that respawns reappears as a new unredeemed copy with a new id. |
| `skylight_unredeem_reward` | Undoes a redemption: refunds the points and clears the redeemed state. |
| `skylight_delete_reward` | Deletes a reward. Returns a preview and changes nothing unless `confirm: true` is set. |
| `skylight_move_routine_step` | Moves a routine step before (`beforeChoreId`) or after (`afterChoreId`) another step, changing the step order. Pass exactly one anchor; ids as listed by `skylight_list_chores`. |
| `skylight_list_lists` | Lists the lists as `{ id, title, kind, color, hiddenOnDevice, itemCount }`. `kind` is `to_do`, `shopping` or `other`. |
| `skylight_list_items` | Items of a list as `{ id, title, done, section, position }`, sorted by section (none first) and position. `includeCompleted` defaults to true. |
| `skylight_create_list` | Creates a list (`title`, optional `kind` default `to_do`, `color` default `#42D792`, `hiddenOnDevice`). |
| `skylight_update_list` | Changes a list's `title`, `kind`, `color` or `hiddenOnDevice`. |
| `skylight_delete_list` | Deletes a list and its items. Preview (title and item count) unless `confirm: true`. |
| `skylight_add_list_items` | Adds 1-100 items (`title`, optional `section`), one request each, with per-item results and `dryRun`. Stops on a login failure or rate limit. Resend only the failed items. |
| `skylight_update_list_item` | Renames an item (`title`), checks it off (`done`) or changes its `section` (`null` removes it from its section). |
| `skylight_move_list_item` | Places an item after another item (`afterItemId`) or at the top (`null`). The target must be in the same section. |
| `skylight_delete_list_items` | Deletes 1-100 items in one request. Preview lists their titles unless `confirm: true`. |
| `skylight_list_events` | Lists calendar events between two dates (default today through 7 days ahead, at most 92 days) with `source` and `editable`. Occurrences of a recurring event have ids like `123-1791803100`. Optional `profileId` filter. |
| `skylight_create_event` | Creates an event. Timed events take `startsAt` as `2026-10-12T18:30`, read as Eastern time (or your `SKYLIGHT_TIMEZONE`) unless you add an offset such as `-04:00` or `Z`; the end defaults to one hour later. All-day events use `allDay: true` with `startDate` (and `endDate`). `profileIds` may be people or labels such as Birthdays. Optional `recurrence`, `timezone`, `location`, `description`, `emoji`, `countdown`. Results carry a human `when`. |
| `skylight_update_event` | Changes fields on an event created in Skylight (the whole series for a recurring one, with `applyTo: "all"`). Refuses events synced from Google or another calendar. |
| `skylight_delete_event` | Deletes an event. Preview unless `confirm: true`. `applyTo`: `one` or `future` need an occurrence id; `all`, or a plain id with no `applyTo`, deletes the whole series. Refuses synced events. |

## Example prompts

- "Show me the profiles on our Skylight, then do a dry run of a weekly chore schedule: Ellie empties the dishwasher every Monday, Wednesday and Friday, and Sam takes out the trash every Tuesday. Don't create anything yet."
- "Create these chores starting next Monday: make bed (daily, 5 points) for Ellie and Sam, feed the dog (daily, morning) for Sam, and set the table (weekdays) for Ellie."
- "Add milk, eggs and bread to the grocery list, with milk and eggs under Dairy, then move bread to the top."
- "Create a reward for Sam called Movie night for 50 points, then redeem it. Show me his balance first."
- "Put the dentist on Monday at 4:30 pm Eastern for Ellie, repeating every week."
- "Add a morning routine for Ellie starting tomorrow with three steps: brush teeth, get dressed, pack backpack. Run it as a dry run first and show me the payloads."

Routine steps are chores with `routine: true` and a `timeOfDay` of `morning`, `afternoon` or `evening` (Skylight's only three routine slots). They take no times: a step's `startTime` is derived by Skylight from its slot, and the recurrence defaults to daily. The order of steps inside a routine is Skylight's `position` field, assigned in creation order; `skylight_move_routine_step` reorders steps afterwards. For example, the three-step prompt above creates:

```json
{ "chores": [
  { "summary": "Brush teeth", "start": "2026-10-13", "profileIds": ["<Ellie>"], "routine": true, "timeOfDay": "morning" },
  { "summary": "Get dressed", "start": "2026-10-13", "profileIds": ["<Ellie>"], "routine": true, "timeOfDay": "morning" },
  { "summary": "Pack backpack", "start": "2026-10-13", "profileIds": ["<Ellie>"], "routine": true, "timeOfDay": "morning" }
] }
```

## Time zones

Skylight stores and returns UTC. skylight-mcp shows you everything in one zone, Eastern time (`America/New_York`) by default, so EST and EDT are handled for you:

- Times you type, such as `startsAt: "2026-10-12T18:30"`, are read as wall-clock time in that zone and sent to Skylight with the right offset (`-04:00` in summer, `-05:00` in winter). Without that conversion Skylight would store 18:30 as 18:30 UTC, which is 2:30 PM Eastern. Add an explicit offset or `Z` if you do mean another zone.
- Times in results are shown in the same zone with an explicit offset (`2026-10-12T18:30:00-04:00`). Events also have a plain-words `when`, such as `Mon Oct 12, 6:30 PM EDT to 7:30 PM EDT`. All-day events show dates only.
- This covers event start and end times, reward `redeemedAt`, chore `completedAt` and the login token expiry in `skylight_auth_status`, `skylight-mcp status`, `login` and `doctor`.
- To use another zone, set `SKYLIGHT_TIMEZONE` to an IANA name such as `America/Chicago` in the `env` block of the Claude Desktop config (`skylight-mcp doctor` prints the block with the variable when it is set). An invalid name stops the server with an error naming the variable.

## Development

Use `skylight-mcp ...` as above, or `node dist/cli.js ...` without linking.

```sh
npm run check        # typecheck, tests and build
npm run live:smoke   # opt-in checks against the real API
```

`npm run live:smoke` uses your stored login and is read-only by default. Set `SKYLIGHT_LIVE_WRITE=1` to also create, update, complete, revert and delete a one-time chore and a daily recurring chore (including deleting a single occurrence and the whole series), the weekly, monthly, interval and until recurrences, a morning routine step (complete, revert, delete as a whole), an up-for-grabs chore, and a field-clearing update. It then runs the phase 2 leg (`scripts/live-smoke-phase2.ts`) on a dedicated smoke profile: rewards (create, update, redeem preview, redeem, unredeem, delete), reordering two routine steps, a list with items (add, complete, rename, move, bulk delete), and calendar events (all-day, timed with offset, weekly recurrence with one occurrence and the series deleted, and the refusal of a synced event when one exists). Everything it creates is prefixed `[skylight-mcp smoke]`, cleaned up in a `finally` block and checked for leftovers. It is not part of the automated tests. Other scripts: `npm run dev:server` and `npm run dev:cli` run the TypeScript sources directly. API notes are in `docs/api.md`.

## Credits

The API knowledge and the Keychain credential-store design come from [kamilio/skylight-calendar-agent](https://github.com/kamilio/skylight-calendar-agent), which is MIT licensed. This project is also MIT licensed. See `LICENSE`.
