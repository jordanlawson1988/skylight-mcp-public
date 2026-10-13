# skylight-mcp

## What it is

skylight-mcp is a local MCP server that lets an AI assistant such as Claude Desktop manage chores, routines, rewards, lists, calendar events, the meal plan and recipes, photos and albums, devices, frame settings and sharing on a Skylight Calendar. It runs on your Mac over stdio and talks to Skylight's web API. The same tools can also run as a shared server on Cloudflare Workers for Claude and ChatGPT on any device (see "Use from Claude and ChatGPT on any device").

This is an unofficial project. It is not affiliated with or endorsed by Skylight. It uses Skylight's private API, which is undocumented and can change or break at any time without notice. It runs on macOS only, because the login credential is stored with the macOS Keychain.

## Safety

- The tool set is deliberate, not complete. Changed 2026-10-12 at Jordan's request: profiles (Skylight categories) can be created, updated and deleted; rewards, lists and calendar events (phase 2) can be created, changed and deleted; and phase 3 adds the meal plan and recipes, photos and albums, devices, frame settings and sharing, and the plan and marketing flag. Every destructive action is confirm-gated. Never exposed: account delete or export, email or password change, frame transfer, alarms and sleep schedules, device config, renaming or hiding the frame, push-notification preferences, and who can see the family's photos (`open_to_public` and `message_viewability`: their values are unverified and a wrong one could publish photos).
- Photo files and links (`asset_url`, `thumbnail_url`), share links, the frame's notification email and the account's email, phone, birthday and name are never returned by any tool. `skylight_list_photos` returns ids, dates, captions and who sent each photo, nothing that opens the file. `from` is `"you"` for photos the frame owner sent (the owner's own email is never returned) and the sender's email for everyone else, which is how Skylight identifies people outside the household; if the owner cannot be identified, `from` is null.
- Deleting photos is permanent and removes them for everyone who shares the frame. `skylight_delete_photos` needs `confirm: true`; its preview lists each photo's date and caption and refuses ids that are not on the frame. Deleting an album keeps its photos on the frame.
- Resetting or removing a device is the most disruptive thing the server can do (a reset wipes the screen; a removed device leaves the frame). `skylight_reset_device` and `skylight_remove_device` need BOTH `confirm: true` and `confirmName`, the device's exact current name (case-sensitive); anything less returns a preview and changes nothing, and a wrong name is refused with the expected one.
- Some actions send real email to people outside the family, so they are confirm-gated too: `skylight_invite_frame_user` (`confirm: true`) and an event's `invitedEmails` (`confirmInvites: true`, on `skylight_create_event` and `skylight_update_event`). Without the flag you get a preview of the addresses and nothing is created, changed or sent. `skylight_block_frame_user` is confirm-gated and refuses the frame owner.
- Meals and recipes: `skylight_delete_meal` needs `confirm: true` and names the date and scope in its preview; a repeating meal always needs an explicit `applyTo`. `skylight_delete_recipe` needs `confirm: true`; its preview counts the distinct meals planned with the recipe in the next 60 days (and the dates they cover, e.g. "2 meals (61 dates)") and says whether they would be deleted (`alsoDeletePlannedMeals`, default false). With `alsoDeletePlannedMeals: true` it also warns that meals planned further out with the recipe would be deleted too.
- Calendar events synced from Google or another calendar are read-only here: `skylight_update_event` and `skylight_delete_event` refuse them (`source` other than `skylight`) before sending any request.
- Deleting a chore requires `confirm: true`. Without it, `skylight_delete_chore` changes nothing and returns a preview of what would be deleted.
- Deleting a reward, a list, list items or a calendar event works the same way: the delete tools need `confirm: true` and otherwise return a preview (reward and list details, the titles of the items, or the scope and a warning when a whole recurring series would go). Deleting a list deletes its items. A recurring event deleted by its plain id, or with `applyTo: "all"`, removes the whole series. `skylight_redeem_reward` spends points, so it is confirm-gated too and its preview shows the current balance.
- Deleting a profile works the same way: `skylight_delete_profile` needs `confirm: true`, and its preview shows the upcoming chore count and where chores and events would go. To retire a person without losing their events, use `skylight_update_profile` with `kind: "label"` (Skylight's "Convert to Label").
- Bulk create validates every item before sending any request, supports `dryRun: true`, and stops early if Skylight rejects the login or rate limits the requests.
- Tokens are stored encrypted with AES-256-GCM. The encryption key lives in the macOS Keychain. Any process running as your user can read that key through `/usr/bin/security` without a prompt, so the encryption protects backups and the file at rest, not against malware on the Mac.
- On the shared server (Claude and ChatGPT over the internet), every call of a tool that can change something is logged with the family member who made it (ids only, 90 days); see "Use from Claude and ChatGPT on any device".
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

If your account has more than one frame, set `SKYLIGHT_FRAME_ID` in the `env` block of that entry. `doctor` includes it when it is set in your environment, and does the same for `SKYLIGHT_TIMEZONE` and `SKYLIGHT_TOOLSETS`.

## Use from Claude and ChatGPT on any device

The same tools can also run as a shared server, so the family can use them from Claude (web, Desktop, iPhone) and ChatGPT Business, each signed in as themselves, on the family's one Skylight frame. It is a Cloudflare Worker (free tier): Claude and ChatGPT connect to it over OAuth, family members sign in with Google, and only the emails on the family list get in. The server holds its own Skylight sign-in (Skylight rotates refresh tokens, so it never shares the Mac's), encrypted in a Durable Object, and logs every change with the family member who made it. The Mac setup above keeps working unchanged.

Run these from your clone of this repository (the commands use its `wrangler.jsonc`). Do staging first, try it, then repeat with `--env production` and `npm run remote:deploy:production`.

1. Sign in to Cloudflare: `npx wrangler login`.
2. Deploy once to get the address: `npm run remote:deploy:staging`. It prints `https://skylight-mcp-staging.<your-subdomain>.workers.dev` (production: `https://skylight-mcp.<your-subdomain>.workers.dev`). The KV namespace is created on this first deploy.
3. Create the server's two internal secrets: `skylight-mcp remote setup --env staging --url https://skylight-mcp-staging.<your-subdomain>.workers.dev`. It saves the address in `~/Library/Application Support/skylight-mcp/remote.json`, generates `SKYLIGHT_TOKEN_KEY` (encrypts the stored Skylight sign-in) and `ADMIN_TOKEN` (for the commands below), uploads both with `wrangler secret put` and keeps the admin token in your Keychain. Neither is printed or written to a file. Running setup again replaces both, after which you run `remote login` again.
4. Create a Google sign-in client: Google Cloud console > APIs & Services > Credentials > Create credentials > OAuth client ID > Web application. Authorized redirect URIs: `https://skylight-mcp-staging.<your-subdomain>.workers.dev/callback` and `https://skylight-mcp.<your-subdomain>.workers.dev/callback`. If the OAuth consent screen is in Testing, add both family emails as test users.
5. Give the Worker the Google client and the family list (each command asks for the value; the CLI never sees the Google secret):

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID --env staging
   npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
   npx wrangler secret put ALLOWED_EMAILS --env staging   # comma-separated, e.g. you@gmail.com,spouse@example.com
   ```

6. Sign the server in to Skylight: `skylight-mcp remote login --env staging`. It is the same Chrome sign-in as `skylight-mcp login`, but the result goes to the server, not to this Mac's store. `skylight-mcp remote status --env staging` shows the server's sign-in.
7. Claude (web, Desktop and iPhone share connectors): Customize > Connectors > Add custom connector, URL `https://skylight-mcp-staging.<your-subdomain>.workers.dev/mcp`. Leave the OAuth client fields empty; Claude registers itself. Connect, approve the consent page, then choose your Google account. Claude Free allows one custom connector.
8. ChatGPT Business: the workspace owner turns on Developer mode for apps in the workspace settings; then, in ChatGPT, Settings > Apps, add a custom MCP server with the same `/mcp` URL and OAuth authentication. If the workspace belongs to an employer, its policy or admin may not allow a personal connector.

What the sign-in shows: a consent page naming the app (Claude or ChatGPT), where access will be sent, and "This connects to the Lawson family Skylight", then Google's account chooser. A Google account that is not on `ALLOWED_EMAILS` gets "This Google account is not on the family list." and no access. The list is checked again on every call, so removing an email takes effect immediately. An app's connection lasts up to 30 days, then it asks you to connect again.

What is logged:

- The activity log: every call of a tool that can change something records when, who (the Google email), which tool, the ids it touched, and whether it worked or was only a preview. No other argument values, no tokens. It keeps 90 days. Ask for it with `skylight_recent_activity`.
- Cloudflare's logs: one line per request with method, path, status and duration. Request headers, bodies and query strings are not logged.

To take access away:

- One person: `skylight-mcp remote revoke <email> --env production` disconnects every app they connected; remove them from `ALLOWED_EMAILS` (`npx wrangler secret put ALLOWED_EMAILS --env production`) to keep them out.
- The server's Skylight access: `skylight-mcp remote logout --env production` (asks first). Tools then answer that Jordan needs to run `skylight-mcp remote login`.

Limits and notes:

- The same confirm gates, previews and tool annotations apply, and Claude and ChatGPT add their own approval prompts for tools that change things. ChatGPT sometimes blocks write calls with its own safety checks, and whether ChatGPT's phone app can use custom connectors is up to OpenAI.
- 300 calls per person every 10 minutes; past that the server answers 429.
- `SKYLIGHT_TOOLSETS` (a Worker var in `wrangler.jsonc`) trims the tool list per environment if a client struggles with many tools.
- The `workers.dev` address is public. Security rests on OAuth with a consent page per app, the Google allowlist and the admin token. Anyone with access to the Cloudflare account can read the Worker's secrets.

## Toolsets

By default the server registers every tool (more than sixty), which some assistants handle poorly. Set `SKYLIGHT_TOOLSETS` to a comma list to trim the tool list to the groups you use:

| Toolset | Tools |
| --- | --- |
| `profiles` | list, create, update and delete profiles and labels |
| `chores` | chores and routine steps |
| `rewards` | reward points and rewards |
| `lists` | lists and list items |
| `calendar` | calendar events |
| `meals` | the meal plan, meal categories and recipes |
| `photos` | photos, captions and albums |
| `devices` | device settings, sleep, reset and remove |
| `frame` | frame settings and who shares the frame |
| `account` | the plan and the marketing-email flag |

`skylight_auth_status` is always registered. Names are case-insensitive. An unknown name stops the server with an error that names it and lists the valid ones. Example for the `env` block of the Claude Desktop entry: `"SKYLIGHT_TOOLSETS": "chores,lists,calendar,meals"`. `skylight-mcp doctor` prints the enabled toolsets.

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
| `skylight_create_event` | Creates an event. Timed events take `startsAt` as `2026-10-12T18:30`, read as Eastern time (or your `SKYLIGHT_TIMEZONE`) unless you add an offset such as `-04:00` or `Z`; the end defaults to one hour later. All-day events use `allDay: true` with `startDate` (and `endDate`). `profileIds` may be people or labels such as Birthdays. Optional `recurrence`, `timezone`, `location`, `description`, `emoji`, `countdown`. `invitedEmails` (up to 20) makes Skylight email an invitation to each address, so it needs `confirmInvites: true` (otherwise a preview). Results carry a human `when`. |
| `skylight_update_event` | Changes fields on an event created in Skylight (the whole series for a recurring one, with `applyTo: "all"`). Accepts `invitedEmails` with `confirmInvites: true` like create (an empty list is ignored, it never removes invitees). Refuses events synced from Google or another calendar. |
| `skylight_delete_event` | Deletes an event. Preview unless `confirm: true`. `applyTo`: `one` or `future` need an occurrence id; `all`, or a plain id with no `applyTo`, deletes the whole series. Refuses synced events. |
| `skylight_list_meal_categories` | Lists the meal slots (Breakfast, Lunch, Dinner, Snack) as `{ id, name, color, enabled, position }`. |
| `skylight_update_meal_category` | Renames a meal slot, changes its `#RRGGBB` `color`, or turns it off or on (`enabled`). |
| `skylight_list_meals` | Lists planned meals between two dates (default today through 7 days ahead, at most 62 days apart), one row per date: `{ mealId, date, category, title, recipeId, note, recurring, recurrenceRule }`, sorted by date and slot. |
| `skylight_plan_meal` | Plans a meal for a `date` in a `category` (id or name, any case). Exactly one of `recipeId` or `title`; optional `note`, `description`, `recurrence` and `addToGroceryList` (default false; needs a recipe; adds its ingredients to the default grocery list). Returns the created rows. |
| `skylight_update_meal` | Changes a planned meal on one of its dates (`title`, `note`, `description`, `category`, `recipeId`). A repeating meal needs `applyTo`: `one` changes that date only and splits it into its own meal with a new `mealId`, `future` that date and later, `all` every date. A one-time meal takes no `applyTo`. |
| `skylight_delete_meal` | Deletes a planned meal on one date (same `applyTo` rule). Preview (title, date, "only this date" / "this date and later" / "every date of this meal" / "this meal") unless `confirm: true`. |
| `skylight_list_recipes` | Lists recipes as `{ id, title, category, ingredientCount }`. |
| `skylight_get_recipe` | One recipe with `ingredients` and `instructions` parsed from the app's `Ingredients:` / `Instructions:` layout (null when a section is missing). |
| `skylight_create_recipe` | Creates a recipe: `title`, `category`, and either a `description` or `ingredients` (with optional `instructions`), which are written in the app's layout. |
| `skylight_update_recipe` | Changes a recipe's title, category, description, ingredients or instructions. It reads the recipe first and merges, because Skylight needs all three fields on every update. |
| `skylight_delete_recipe` | Deletes a recipe. Preview (the distinct meals and dates in the next 60 days that use it) unless `confirm: true`. `alsoDeletePlannedMeals: true` deletes those meals too (default false). |
| `skylight_add_recipe_to_grocery_list` | Asks Skylight to add the recipe's ingredients to the default grocery list; they appear a few seconds later. Not idempotent: calling twice adds them twice. |
| `skylight_list_photos` | Lists photos and videos, newest first, one page at a time: `{ page, pages, photos: [{ id, type, createdAt, caption, from, commentsCount }] }`. `from` is `"you"` for the owner's own photos, else the sender's email. No file links. |
| `skylight_update_photo_caption` | Sets a photo's caption (up to 200 characters); an empty caption clears it. |
| `skylight_delete_photos` | PERMANENTLY deletes 1-50 photos for everyone. Preview (each photo's date and caption) unless `confirm: true`. |
| `skylight_list_albums` | Lists albums as `{ id, title, photoCount, videoCount, editable }`. |
| `skylight_create_album` | Creates an empty album. |
| `skylight_rename_album` | Renames an album (built-in albums are refused). |
| `skylight_delete_album` | Deletes an album; its photos stay on the frame. Preview unless `confirm: true`. |
| `skylight_add_photos_to_album` | Adds 1-100 photos to an album. |
| `skylight_remove_photos_from_album` | Takes 1-100 photos out of an album (they stay on the frame). |
| `skylight_list_devices` | Lists devices with their name, brightness, sleep window, slideshow settings and `currentAlbumId` (`"all"` or an album id). |
| `skylight_update_device` | Changes only the settings you pass: `name`, `brightness` (0-255), `sleepsAt` / `wakesAt` (HH:mm), `sleepModeOn`, `showCaption`, `showHeart`, `blurEffect`, `startSound`, `slideshowSpeed` (1-3600), `slideshowStyle` (0-10), `albumId` (an id or `"all"`). |
| `skylight_set_device_sleep` | Puts the screen to sleep (`asleep: true`) or wakes it. |
| `skylight_reset_device` | Resets a device (the screen is wiped and must be set up again). Needs `confirmName` (the exact device name) AND `confirm: true`; otherwise a preview. |
| `skylight_remove_device` | Removes a device from the frame. Needs `confirmName` AND `confirm: true`; otherwise a preview. |
| `skylight_get_frame` | The frame's name, time zone, household name, locale, photo-sharing setting, enabled `features` and `plus`. No share link or contact details. |
| `skylight_update_frame` | Changes the household name (`null` clears it), time zone or locale. Photo privacy settings are deliberately not available. |
| `skylight_list_frame_users` | Lists who shares the frame: `{ userId, email, status, owner }`. |
| `skylight_invite_frame_user` | Invites a person by email. Skylight emails them, so it previews unless `confirm: true`. |
| `skylight_block_frame_user` | Blocks someone from the frame (never the owner). Preview unless `confirm: true`. |
| `skylight_unblock_frame_user` | Gives a blocked person access again, or approves one who is waiting. |
| `skylight_get_account` | The plan, subscriptions (`{ status, cadence, type }`) and marketing-email flag. No email, phone, birthday or name. |
| `skylight_set_marketing_emails` | Turns Skylight's marketing emails on or off. |
| `skylight_recent_activity` | Shared server only: the latest changes made through it (when, who, tool, ids, ok or preview), newest first; `limit` 1 to 50, default 20. |

## Example prompts

- "Show me the profiles on our Skylight, then do a dry run of a weekly chore schedule: Ellie empties the dishwasher every Monday, Wednesday and Friday, and Sam takes out the trash every Tuesday. Don't create anything yet."
- "Create these chores starting next Monday: make bed (daily, 5 points) for Ellie and Sam, feed the dog (daily, morning) for Sam, and set the table (weekdays) for Ellie."
- "Add milk, eggs and bread to the grocery list, with milk and eggs under Dairy, then move bread to the top."
- "Create a reward for Sam called Movie night for 50 points, then redeem it. Show me his balance first."
- "Put the dentist on Monday at 4:30 pm Eastern for Ellie, repeating every week."
- "Plan tacos for Tuesday dinner and every Tuesday after, then add the ingredients to the grocery list."
- "Create a recipe called Sheet-pan chicken for dinner with these ingredients and steps, then put it on Thursday."
- "Show me the newest photos, caption the first one 'First day of school', and make an album called School 2026 with it."
- "Dim the Skylight to 40% and put it to sleep at 9:30 pm."
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

- Times you type, such as `startsAt: "2026-10-12T18:30"`, are read as wall-clock time in that zone and sent to Skylight with the right offset (`-04:00` in summer, `-05:00` in winter). Without that conversion Skylight would store 18:30 as 18:30 UTC, which is 2:30 PM Eastern. Add an explicit offset or `Z` if you do mean another zone. A time that does not exist because the clocks skip forward (such as 2:30 AM on the spring-forward Sunday) is refused with a request to pick another time; a time that happens twice when the clocks fall back resolves to the first (daylight) occurrence. "Today" and the default date ranges also come from this zone, not from the machine's.
- Times in results are shown in the same zone with an explicit offset (`2026-10-12T18:30:00-04:00`). Events also have a plain-words `when`, such as `Mon Oct 12, 6:30 PM EDT to 7:30 PM EDT`. All-day events show dates only.
- This covers event start and end times, reward `redeemedAt`, chore `completedAt` and the login token expiry in `skylight_auth_status`, `skylight-mcp status`, `login` and `doctor`.
- To use another zone, set `SKYLIGHT_TIMEZONE` to an IANA name such as `America/Chicago` in the `env` block of the Claude Desktop config (`skylight-mcp doctor` prints the block with the variable when it is set). An invalid name stops the server with an error naming the variable.

## Development

Use `skylight-mcp ...` as above, or `node dist/cli.js ...` without linking.

```sh
npm run check        # typecheck (Mac, tests, Worker), tests, build, and the Worker's dry-run bundle
npm run remote:dev   # the shared server locally (wrangler dev; put dummy secrets in .dev.vars)
npm run live:smoke   # opt-in checks against the real API
```

Dependencies are pinned to exact versions, normally ones published at least 14 days earlier. One exception: `wrangler` is 4.149.0 (published 2026-10-08), with `@cloudflare/workers-types` 5.20261006.1 to match its workerd 1.20261006. 4.149.0 is the oldest wrangler without high-severity `npm audit` advisories (checked 2026-10-12): npm lists wrangler up to 4.148.0 as affected through miniflare, 4.142.0 reported high advisories in `undici` (7.0 to 7.29) and `sharp` (below 0.35.5), and 4.148.0 still reported the `sharp` one. Both tools are development-only; neither is in the deployed Worker.

`npm run live:smoke` uses your stored login and is read-only by default. Set `SKYLIGHT_LIVE_WRITE=1` to also create, update, complete, revert and delete a one-time chore and a daily recurring chore (including deleting a single occurrence and the whole series), the weekly, monthly, interval and until recurrences, a morning routine step (complete, revert, delete as a whole), an up-for-grabs chore, and a field-clearing update. It then runs the phase 2 leg (`scripts/live-smoke-phase2.ts`) on a dedicated smoke profile: rewards (create, update, redeem preview, redeem, unredeem, delete), reordering two routine steps, a list with items (add, complete, rename, move, bulk delete), and calendar events (all-day, timed with offset, weekly recurrence with one occurrence and the series deleted, and the refusal of a synced event when one exists). After that comes the phase 3 leg (`scripts/live-smoke-phase3.ts`): a recipe with two `zzsmoke` ingredients (parsed back), a one-time and a daily meal, `applyTo` one (a new `mealId` appears), delete one date and the rest of the series, adding the recipe to the grocery list and waiting up to 15 seconds for the two items (then deleting them), deleting the recipe together with its planned meal, an album (create, rename, add and remove the newest photo, delete), setting and restoring the newest photo's caption, flipping and restoring a device's `showHeart`, and a no-op frame time-zone update. The smoke never resets or removes a device, deletes photos, invites or blocks anyone, or changes marketing emails. Everything it creates is prefixed `[skylight-mcp smoke]`, cleaned up in a `finally` block and checked for leftovers. It is not part of the automated tests. Other scripts: `npm run dev:server` and `npm run dev:cli` run the TypeScript sources directly. API notes are in `docs/api.md`.

## Credits

The API knowledge and the Keychain credential-store design come from [kamilio/skylight-calendar-agent](https://github.com/kamilio/skylight-calendar-agent), which is MIT licensed. This project is also MIT licensed. See `LICENSE`.
