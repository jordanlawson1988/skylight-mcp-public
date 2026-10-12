# skylight-mcp

## What it is

skylight-mcp is a local MCP server that lets an AI assistant such as Claude Desktop manage chores, routines and reward points on a Skylight Calendar. It runs on your Mac over stdio and talks to Skylight's web API.

This is an unofficial project. It is not affiliated with or endorsed by Skylight. It uses Skylight's private API, which is undocumented and can change or break at any time without notice. It runs on macOS only, because the login credential is stored with the macOS Keychain.

## Safety

- The tool set is narrow. There are no tools for accounts, devices, photos, calendar events, lists or meals.
- Deleting a chore requires `confirm: true`. Without it, `skylight_delete_chore` changes nothing and returns a preview of what would be deleted.
- Bulk create validates every item before sending any request, supports `dryRun: true`, and stops early if Skylight rejects the login or rate limits the requests.
- Tokens are stored encrypted with AES-256-GCM. The encryption key lives in the macOS Keychain.
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

The command prints a link to Skylight's authorize page. Open it in a browser. The page needs Skylight's own server-side sign-in, not the session from the Skylight web app, so you may be asked to sign in even if the web app is already open. After you sign in, the browser lands on `https://ourskylight.com/welcome?code=...`. Copy the full address from the address bar and paste it into the terminal prompt.

If a login was started earlier and you only have the final URL, run `skylight-mcp login --complete <url>` to finish it. `--pkce S256|plain` selects the PKCE method (default `S256`).

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
| `skylight_list_chores` | Lists chores and routine steps in a date range (default today through 14 days ahead). |
| `skylight_create_chore` | Creates one chore or routine step for one or more profiles. Returns `{ created, ids }`, because Skylight makes one chore per assigned profile. |
| `skylight_bulk_create_chores` | Creates up to 50 chores in one call. Validates all items first and supports `dryRun: true`. |
| `skylight_update_chore` | Changes fields on an existing chore. Only the fields you pass change. `applyTo` currently accepts only `"all"`; per-occurrence scopes are not available yet. |
| `skylight_delete_chore` | Deletes a chore. Returns a preview and changes nothing unless `confirm: true` is set. |
| `skylight_complete_chore` | Marks one occurrence done for a profile on a date, or reverts it with `done: false`. |
| `skylight_get_reward_points` | Shows the current point balance per profile. |
| `skylight_add_reward_points` | Adds or subtracts points for one or more profiles. Negative values subtract. |
| `skylight_list_rewards` | Lists the rewards the family has set up, with point cost and redemption state. |

## Example prompts

- "Show me the profiles on our Skylight, then do a dry run of a weekly chore schedule: Ellie empties the dishwasher every Monday, Wednesday and Friday, and Sam takes out the trash every Tuesday. Don't create anything yet."
- "Create these chores starting next Monday: make bed (daily, 5 points) for Ellie and Sam, feed the dog (daily, morning) for Sam, and set the table (weekdays) for Ellie."
- "Add a morning routine for Ellie starting tomorrow: brush teeth at 7:00, get dressed at 7:10, pack backpack at 7:20. Run it as a dry run first and show me the payloads."

## Development

Use `skylight-mcp ...` as above, or `node dist/cli.js ...` without linking.

```sh
npm run check        # typecheck, tests and build
npm run live:smoke   # opt-in checks against the real API
```

`npm run live:smoke` uses your stored login and is read-only by default. Set `SKYLIGHT_LIVE_WRITE=1` to also create, update, complete and delete one test chore. It is not part of the automated tests. Other scripts: `npm run dev:server` and `npm run dev:cli` run the TypeScript sources directly. API notes are in `docs/api.md`.

## Credits

The API knowledge and the Keychain credential-store design come from [kamilio/skylight-calendar-agent](https://github.com/kamilio/skylight-calendar-agent), which is MIT licensed. This project is also MIT licensed. See `LICENSE`.
