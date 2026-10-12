# skylight-mcp

## What it is

skylight-mcp is a local MCP server that lets an AI assistant such as Claude Desktop manage chores, routines and reward points on a Skylight Calendar. It runs on your Mac over stdio and talks to Skylight's web API.

This is an unofficial project. It is not affiliated with or endorsed by Skylight. It uses Skylight's private API, which is undocumented and can change or break at any time without notice. It runs on macOS only, because the login credential is stored with the macOS Keychain.

## Safety

- The tool set is narrow. There are no tools for accounts, devices, photos, calendar events, lists or meals. Never exposed: account delete or export, email or password change, frame transfer. Reserved for later phases, each destructive action confirm-gated. Changed 2026-10-12 at Jordan's request: profiles (Skylight categories) can now be created, updated and deleted.
- Deleting a chore requires `confirm: true`. Without it, `skylight_delete_chore` changes nothing and returns a preview of what would be deleted.
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
| `skylight_list_chores` | Lists chores and routine steps in a date range (default today through 14 days ahead), sorted by `instanceDate` then summary. Overdue occurrences are only included with `includeLate: true` (default false; can be large). Recurring occurrences carry a `seriesId` and an `instanceDate`; ids of later occurrences look like `123-2026-10-13`, and routine-step occurrences like `123-2026-10-13-0600` (pass ids exactly as listed). |
| `skylight_create_chore` | Creates one chore or routine step for one or more profiles. Returns `{ created, ids }`, because Skylight makes one chore per assigned profile. |
| `skylight_bulk_create_chores` | Creates up to 50 chores in one call. Validates all items first and supports `dryRun: true`. |
| `skylight_update_chore` | Changes fields on an existing chore. Only the fields you pass change. Accepts plain or composite ids (the series id is used). `applyTo` accepts only `"all"`; per-occurrence scopes are not available for update. |
| `skylight_delete_chore` | Deletes a chore. Returns a preview and changes nothing unless `confirm: true` is set. One-time chore: omit `applyTo`. Recurring chore: `applyTo: "all"` deletes the whole series, `"future"` deletes the given occurrence and all later ones, `"one"` deletes only that occurrence. `"one"` and `"future"` need the occurrence date: pass a composite id such as `123-2026-10-13`, or the plain id plus `instanceDate`. |
| `skylight_complete_chore` | Marks a chore done, or reverts it with `done: false`. Recurring chores need the occurrence date (a composite id like `123-2026-10-13`, or `instanceDate`); one-time chores must omit it. `profileId` is optional and only for up-for-grabs chores. |
| `skylight_get_reward_points` | Shows the current point balance per profile. |
| `skylight_add_reward_points` | Adds or subtracts points for one or more profiles. Negative values subtract. |
| `skylight_list_rewards` | Lists the rewards the family has set up, with point cost and redemption state. |

## Example prompts

- "Show me the profiles on our Skylight, then do a dry run of a weekly chore schedule: Ellie empties the dishwasher every Monday, Wednesday and Friday, and Sam takes out the trash every Tuesday. Don't create anything yet."
- "Create these chores starting next Monday: make bed (daily, 5 points) for Ellie and Sam, feed the dog (daily, morning) for Sam, and set the table (weekdays) for Ellie."
- "Add a morning routine for Ellie starting tomorrow with three steps: brush teeth, get dressed, pack backpack. Run it as a dry run first and show me the payloads."

Routine steps are chores with `routine: true` and a `timeOfDay` of `morning`, `afternoon` or `evening` (Skylight's only three routine slots). They take no times: a step's `startTime` is derived by Skylight from its slot, and the recurrence defaults to daily. The order of steps inside a routine is Skylight's `position` field, assigned in creation order; a tool to reorder steps is planned for a later phase. For example, the three-step prompt above creates:

```json
{ "chores": [
  { "summary": "Brush teeth", "start": "2026-10-13", "profileIds": ["<Ellie>"], "routine": true, "timeOfDay": "morning" },
  { "summary": "Get dressed", "start": "2026-10-13", "profileIds": ["<Ellie>"], "routine": true, "timeOfDay": "morning" },
  { "summary": "Pack backpack", "start": "2026-10-13", "profileIds": ["<Ellie>"], "routine": true, "timeOfDay": "morning" }
] }
```

## Development

Use `skylight-mcp ...` as above, or `node dist/cli.js ...` without linking.

```sh
npm run check        # typecheck, tests and build
npm run live:smoke   # opt-in checks against the real API
```

`npm run live:smoke` uses your stored login and is read-only by default. Set `SKYLIGHT_LIVE_WRITE=1` to also create, update, complete, revert and delete a one-time chore and a daily recurring chore (including deleting a single occurrence and the whole series), the weekly, monthly, interval and until recurrences, a morning routine step, an up-for-grabs chore, and a field-clearing update. It is not part of the automated tests. Other scripts: `npm run dev:server` and `npm run dev:cli` run the TypeScript sources directly. API notes are in `docs/api.md`.

## Credits

The API knowledge and the Keychain credential-store design come from [kamilio/skylight-calendar-agent](https://github.com/kamilio/skylight-calendar-agent), which is MIT licensed. This project is also MIT licensed. See `LICENSE`.
