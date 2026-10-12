# Observed Skylight API (unofficial)

Everything here is observed from the Skylight web app (`https://ourskylight.com`, Expo bundle
`_expo/static/js/web/index-*.js`) and the reference project's HAR capture on 2026-10-12.
Nothing is guaranteed by Skylight.

## Hosts and headers

- API: `https://app.ourskylight.com`
- `Authorization: Bearer <access token>`, `accept: application/json`, `Skylight-Api-Version: 2026-05-01`
- OAuth: `/oauth/authorize` requires a Skylight server-side login session (`/auth/session/new`);
  the web app's own localStorage token does not satisfy it. PKCE S256 is sent on authorize and
  `code_verifier` on `/oauth/token`. (Verified live: see "Login verification" below.)

## Frames and profiles

- `GET /api/frames/calendar` → `{ data: [{ id, attributes: { name?, household_name? } }] }`
- Profiles are categories: `GET /api/frames/{frameId}/categories`.
  Attribute names used by the web app: `label` (display name), `color`, `emoji`,
  `selected_for_chore_chart`, `linked_to_profile`, `profile_picture_urls`. Verified live 2026-10-12: there is no adult/child flag at all, so the tool exposes `kind` ("profile" when `linked_to_profile` is true, "label" otherwise) and `onChoreChart` instead.

## Profiles (categories)

Source tags: [bundle] read from the Skylight web app bundle, [live] observed on a real frame. Unmarked write behavior is unverified until the live smoke has run.

- List: `GET /api/frames/{f}/categories` → `{ data: [{ id, type: "category", attributes: { id, label, color, selected_for_chore_chart, linked_to_profile, profile_picture_urls } }] }` [live]. No emoji, birthday or adult field on categories [live]. A person ("profile") has `linked_to_profile: true`; a calendar "label" (e.g. Birthdays) has `linked_to_profile: false` [live].
- Get one: `GET /api/frames/{f}/categories/{id}` exists [bundle].
- Create: `POST /api/frames/{f}/categories` body `{ label, color, linked_to_profile, selected_for_chore_chart }`; the web app always sets `selected_for_chore_chart` equal to `linked_to_profile` [bundle]. Optional query `link_own_profile=true` links the category to the signed-in user; the MCP does not expose it [bundle].
- Update: `PUT /api/frames/{f}/categories/{id}` with any of `{ label, color, linked_to_profile, selected_for_chore_chart }`; when `linked_to_profile` is sent, the web app sends `selected_for_chore_chart` with the same value. "Convert to label" in the app is `linked_to_profile: false` [bundle].
- Delete: `DELETE /api/frames/{f}/categories/{id}` with optional query `reassign_to_category_id=<other id>`, which moves the deleted category's chores and events to that category [bundle]. The app's UI only offers delete for labels and "Convert to Label" for profiles; the API itself deletes a person profile directly, no convert-to-label needed [live 2026-10-12]. Deleting a profile without `reassign_to_category_id` deletes its chores with it [live 2026-10-12]; with `reassign_to_category_id`, its chores move to the target profile (a chore reappeared assigned to the target) [live 2026-10-12].
- Color is a hex string like `#CB434C` [live].
- MCP mapping: `kind` is "profile" or "label" (`PROFILE_KINDS` in `src/skylight/vocab.ts`); `skylight_delete_profile` previews without `confirm: true`.

## Chores and routines

- List: `GET /api/frames/{frameId}/chores?after=&before=&include_late=&include_up_for_grabs=&filter=linked_to_profile`
  (the MCP tool `skylight_list_chores` sends `include_late=false` unless `includeLate: true` is passed, because late occurrences go back months and a live run returned 608 chores; results are sorted by `instanceDate`, nulls last, then summary.)
- Create: `POST /api/frames/{frameId}/chores/create_multiple` with
  `{ summary, start, start_time, routine, up_for_grabs, recurrence_set, recurring_until, category_ids, reward_points, emoji_icon }`
- Update: `PUT /api/frames/{frameId}/chores/{id}` with the same attributes plus
  `apply_to`, `apply_to_profiles`, `category_ids`, `after`, `before` (web app `updateChore`).
- Delete: `DELETE /api/frames/{frameId}/chores/{id}`. `apply_to` is a query parameter on DELETE (and a body field on PUT update); see "Verified chore semantics" below.
  Bulk delete exists (`DELETE .../chores/destroy_multiple` with `{ ids }`) and is deliberately not exposed.
- Completion: `PUT /api/frames/{frameId}/chores/{seriesId}/completions` with
  `{ status, instance_date, instance_time, category_id, completed_on }`.
- Reorder routine steps: `POST .../chores/{seriesId}/move`, verified live 2026-10-12; see "Routine reorder" below (the bundle's `reorderRoutine` is this call).

### Vocabularies (from the bundle)

- `apply_to`: enum `ScheduledItemUpdateApplyTo` = `{ This: "one", Future: "future", All: "all" }`.
  Shared with calendar events and meals.
- Completion `status`: `"complete"` marks done; `"pending"` is the default/undone state.
  The web app optimistically sets `attributes.status = "complete"` on completion.
- Task list buckets: `late`, `any_day`, `today_timed`, `today`, `future`.

## Rewards

- `GET /api/frames/{frameId}/rewards` returns `{ data: [{ id, type: "reward", attributes: { name, emoji_icon, description, point_value, respawn_on_redemption, redeemed_at, origin }, relationships? }] }`. The cost is `point_value`.
- `GET /api/frames/{frameId}/reward_points` returns a PLAIN ARRAY, not JSON:API: `[{ category_id: number, lifetime_points_earned: number, current_point_balance: number }, ...]`, one entry per category. Labels such as Birthdays are included.
- `POST /api/frames/{frameId}/reward_points` with `{ category_ids, points }` (negative subtracts).

### Rewards (phase 2, verified live 2026-10-12) [live]

- `GET /rewards` returns `{ data: [reward] }` with `relationships.category.data.id` (the profile the reward belongs to) and `meta { just_redeemed, redeemed_by_device_id }`. The default list shows unredeemed rewards; `?redeemed_at_min=<ISO>&redeemed_at_max=<ISO>` filters by redemption time (the tool uses `redeemed_at_min=1970-01-01T00:00:00Z` for `includeRedeemed`). `GET /rewards/{id}` works.
- Create: `POST /rewards` with `{ name, point_value, emoji_icon, description, respawn_on_redemption, category_ids }` returns `{ data: [reward, ...] }`, an ARRAY with one reward per profile id. Omitting `category_ids` is 422 "Category ids is required."
- Update: `PATCH /rewards/{id}` with any of `{ name, point_value, emoji_icon, description, respawn_on_redemption, category_id }` (singular `category_id` on update). Delete: `DELETE /rewards/{id}`.
- Redeem: `POST /rewards/{id}/redeem` with no body deducts `point_value` from the profile's `current_point_balance` and sets `redeemed_at`. If `respawn_on_redemption` is true a NEW unredeemed copy (new id) appears in the default list and the redeemed one drops out of it. A balance that is too low is 400 `{"errors":["Not enough points to redeem reward."]}` (the tool maps it to a ValidationError with the numbers).
- Unredeem: `POST /rewards/{id}/unredeem` refunds the points and clears `redeemed_at`.
- The response shape of update, redeem and unredeem is not pinned down; the mapper accepts `{ data: reward }` or `{ data: [reward] }` and falls back to the pre-read reward.

### Routine reorder [live]

- `POST /chores/{choreId}/move` with `{ position: { before: <otherSeriesId> } }` or `{ position: { after: <otherSeriesId> } }` returns 200 with an empty body; the `attributes.position` of the listed steps changes accordingly. Numeric series ids only; the tool strips composite ids and sends numbers.

### Lists [live]

- `GET /lists` returns `{ data: [{ id, type: "list", attributes { label, color, kind, hide_on_device, draft, default_grocery_list }, relationships.list_items.data: [{id}] }], included: [list_item...] }`. `kind` is `to_do`, `shopping` or `other` (`LIST_KINDS`). `GET /lists/{id}` works. `POST /lists` and `PUT /lists/{id}` take `{ label, kind, color, hide_on_device }` (any subset on PUT); `DELETE /lists/{id}`.
- `GET /lists/{id}/list_items` returns `{ data: [{ id, type: "list_item", attributes { id, label, status, section, position, created_at, draft } }] }`. `status` is `pending` or `completed` (`LIST_ITEM_STATUS`). `section` is a free-text group name or null.
- `POST /lists/{id}/list_items` with `{ label, section }` adds one item per call. `PUT /lists/{id}/list_items/{itemId}` takes any of `{ label, status, section }`. `DELETE /lists/{id}/list_items/{itemId}`; `DELETE /lists/{id}/list_items/bulk_destroy` with `{ ids: [number...] }` (the tool uses this).
- Move: `POST /lists/{id}/list_items/{itemId}/move` with `{ after_item_id: <number> | null }` (null = top). The target must be in the SAME section, else 422 "After item must be in the same scope" (mapped to a ValidationError on `afterItemId`).
- `PUT /lists/{id}/list_items/bulk_update_section` with `{ item_ids: [...], section }` exists in the web app bundle but is UNVERIFIED and not exposed.

### Calendar events [live]

- `GET /calendar_events?date_min=YYYY-MM-DD&date_max=YYYY-MM-DD` (both required; `date_max` is EXCLUSIVE, see below) returns `{ data: [event], included: [category, calendar_account] }`. Attributes: `uid, summary, invited_emails, status, all_day, timezone, starts_at, ends_at, recurring, recurring_config, rrule ([string] | null), master_event_id, description, location, lat, lng, source ("skylight", "google", ...), kind ("standard"), editable, countdown_enabled, emoji_icon, owner_email, calendar_id`; `relationships.category.data.id`. Occurrences of a recurring event have composite ids `<masterId>-<unixSeconds>`.
- Create: `POST /calendar_events` with `{ summary, kind: "standard", category_ids, starts_at, ends_at, all_day, rrule: ["RRULE:..."] | null, invited_emails: [], location, lat, lng, description, emoji_icon, calendar_account_id: null, calendar_id: null, timezone, countdown_enabled }`.
- TIME ZONES: a `starts_at` without an offset is treated as UTC, so a bare `2026-10-12T18:30:00` lands at 2:30 PM Eastern. With an explicit offset (`2026-10-12T18:30:00-04:00`) the local time is kept and echoed as `2026-10-12T18:30:00.000-04:00`. The tools never send a bare time: `toOffsetDateTime` (`src/skylight/time.ts`) reads a bare input as wall-clock time in `SKYLIGHT_TIMEZONE` (default `America/New_York`), resolves the offset for that date with Intl, and sends the explicit offset. A wall time inside a spring-forward gap does not exist and is refused; a repeated fall-back hour resolves to the first (daylight) occurrence. Parsing never goes through the process zone (`parseInstant` reads a suffix-less datetime as UTC) and "today" is `todayIn(SKYLIGHT_TIMEZONE)`. Offsets are `±HH:mm`; pre-1900 local-mean-time offsets with seconds are not supported. Output is converted the other way (`formatOffsetDateTime`, `formatHuman`) for event times, reward `redeemed_at`, chore `completed_at` and token expiry. All-day events are not converted: Skylight returns them as UTC midnight (`2026-10-08T00:00:00.000Z`), which is shown as the plain date. All-day events send `starts_at`/`ends_at` as `YYYY-MM-DD` with `all_day: true`; a single-day all-day event has `ends_at` equal to `starts_at`.
- Update: `PUT /calendar_events/{id}` with any of the create fields plus `apply_to`. The tool sends the master id and only exposes `apply_to: "all"`, as for chores.
- Delete: `DELETE /calendar_events/{id}?apply_to=one|future|all`. Verified: a composite occurrence id with `one` removes that occurrence; a composite id with `future` removes it and later ones; a master id with no `apply_to` removes the whole series. The tool therefore sends `apply_to` only for `one` and `future`; `applyTo: "all"` deletes the master id with NO query. The response is `{ meta: { destroyed_id } }`.
- Synced calendars: events whose `source` is not `skylight` (80 Google events in a two-week window on the test frame) live on the frame too. The update and delete tools look the event up in a listing (a 3-day window around an occurrence, or a year either side of today for a plain id) and refuse with "this event comes from a synced <source> calendar; change it there". Two failure modes differ on purpose: if the lookup request itself fails (any API error) the tools fail CLOSED with "could not verify whether this event comes from a synced calendar; try again"; if the lookup succeeds but the event is not in the window they fail OPEN and let the request through, so the server decides. Residual risk: a synced event more than 365 days from today (or an occurrence outside its 3-day window) is not detected. When the lookup finds nothing, the delete preview says it could not check and that a whole series may go.
- Datetimes: the tools accept fractional seconds (`2026-10-12T18:30:00.000-04:00`) so listed values can be passed back unchanged.

## Phase 3: meals, recipes, photos, devices, frame, sharing, account

Source tags: [live] observed against a real frame on 2026-10-12 (the sanitized responses are in `test/fixtures/`), [bundle] read from the web app bundle and NOT exercised live. Every path below is under `/api/frames/{f}` unless it starts with `/api/`.

### Meal categories and recipes [live]

- `GET /meals/categories` returns `{ data: [{ id, type: "meal_category", attributes { color, icon, label, enabled, position } }] }` (Breakfast, Lunch, Dinner, Snack). `PATCH /meals/categories/{id}` takes any of `{ label, color, enabled }`. The tool maps `label` to `name` and drops `icon`.
- `GET /meals/recipes?include=meal_category` returns `{ data: [{ id, type: "meal_recipe", attributes { summary, description, draft, image_url, source }, relationships { meal_category, partner } }], included: [category...] }`. `GET /meals/recipes/{id}?include=meal_category,partner` is the same for one.
- `POST /meals/recipes?include=meal_category` with `{ meal_category_id, summary, description }` returns `{ data: recipe }`. `PATCH /meals/recipes/{id}?include=meal_category` takes the same body and Skylight wants all three fields, so `skylight_update_recipe` reads the recipe first and merges. `DELETE /meals/recipes/{id}` takes an optional `apply_to_sittings=true`, which ALSO deletes meals planned with the recipe and answers `{ meta: { deleted_sitting_ids } }`.
- Description convention used by the app: `Ingredients:\n- a\n- b\n\nInstructions:\n1. x\n2. y\n`. `skylight_get_recipe` parses it (heading match ignores case; an ingredient is a line starting with a `- `, `* ` or `• ` bullet; instruction numbering `1.` / `1)` or a bullet is stripped; building always writes `- ` and `1.`); a description with no such section yields null lists and is never rebuilt by an ingredients/instructions update.
- `POST /meals/recipes/{id}/add_to_grocery_list` with `{ draft: false }` returns `{ data: recipe, meta: { auto_creation_intent_id } }`. Skylight then extracts the ingredients asynchronously (a few seconds) and adds them to the default grocery list (`lists[].attributes.default_grocery_list === true`). `{ draft: true }` adds nothing visible, so the tool always sends false. Calling it twice adds the items twice.

### Meal plan ("sittings") [live]

- `GET /meals/sittings?date_min=YYYY-MM-DD&date_max=YYYY-MM-DD&include=meal_category,meal_recipe` (`date_min` required; `date_max` is EXCLUSIVE, see "Date windows" below) returns `{ data: [sitting], included, meta }`. A sitting has `attributes { summary, description, note, rrule, draft, recurring, instances: ["YYYY-MM-DD", ...] }` and `relationships { meal_category, meal_recipe (nullable), profiles }`. One sitting row covers several dates (`instances`); `skylight_list_meals` explodes it into one row per date. `rrule` is stored WITHOUT the `RRULE:` prefix (`FREQ=DAILY`).
- `POST /meals/sittings?date_min=..&date_max=..&include=..` with `{ meal_category_id, meal_recipe_id?, add_to_grocery_list, summary?, date, note?, description?, rrule? }` returns `{ data: [sitting] }`. `add_to_grocery_list: true` is NOT live-tested (the smoke only plans meals with it false); `skylight_plan_meal` with `addToGroceryList: true` therefore relies on the field's name in the web bundle, and `skylight_add_recipe_to_grocery_list` is the verified way to put a recipe's ingredients on the list. With a recipe and no summary the title and description come from the recipe. `rrule: "RRULE:FREQ=DAILY"` is accepted and stored as `FREQ=DAILY`; the tool strips the prefix itself (`stripRrulePrefix`) after building the rule with `buildRrule` (no `BYHOUR`).
- `PATCH /meals/sittings/{id}/instances/{date}?date_min&date_max&include&apply_to=one|future|all` takes any of `{ summary, note, description, meal_category_id, meal_recipe_id, rrule }`. A one-time sitting takes NO `apply_to`. `apply_to=one` on a recurring sitting splits that date into a NEW sitting (new id) and removes the date from the series, so the tool re-reads the date after the update and returns the meals on it. The tool does not expose `rrule` changes.
- `DELETE /meals/sittings/{id}/instances/{date}?apply_to=..`: on a recurring sitting `one` removes that date, `future` truncates the rule with `UNTIL`, `all` deletes the series (and the sittings split from it). On a one-time sitting any `apply_to` is a 422 ("must not provide apply_to with a non-recurring..."). The tools therefore look the meal up on that date first and require `applyTo` exactly when `recurring` is true (`MEAL_SCOPE` in `vocab.ts`).

### Date windows: `date_max` is exclusive [live 2026-10-12]

- On both `GET /meals/sittings` (and the `POST`/`PATCH` that take the same `date_min`/`date_max`/`include` query) and `GET /calendar_events`, a row or instance is returned only when `date_min <= date < date_max`. Verified: `POST /meals/sittings` with `date_min=D&date_max=D` creates the meal but answers it with `instances: []`, while `date_max=D+1` answers `instances: ["D"]`; `GET /meals/sittings` with D..D returns no rows; `GET /calendar_events` with D..D returns 0 events and D..D+1 returns that day's events.
- The tools take INCLUSIVE `after`/`before` dates, so every sender converts with `exclusiveDateMax` (`src/skylight/time.ts`, the day after, across month and year ends such as 2026-12-31 to 2027-01-01): `skylight_list_events`, the synced-source lookup of `skylight_update_event` and `skylight_delete_event`, `skylight_list_meals`, `skylight_plan_meal`, the meal lookups of `skylight_update_meal` and `skylight_delete_meal` (and the re-read after an update), and the planned-meal count of the `skylight_delete_recipe` preview. Until 2026-10-12 `skylight_list_events` sent `before` as is and so dropped the last day of every window (a phase 2 bug).
- The chores list (`after` / `before`) is a different endpoint with different parameter names and was not re-checked for this.

### Photos ("messages") and albums

- `GET /messages?page=N` [live] returns `{ data: [message], meta { current_page, num_pages, frame_owner } }` with `attributes { asset_type ("photo" | "video"), created_at, caption, comments_count, from_email, sender_id, asset_url, thumbnail_url, ... }`. `GET /messages/{id}` works [live]. `PUT /messages/{id}/caption` with `{ caption }` works [live, verified and reverted]. The tools never return `asset_url`, `thumbnail_url`, storage keys or owner ids. `mapPhoto` reads only id, type, created time, caption and comment count, plus `sender_id`, `frame_owner_id` and `from_email` to decide `from`: `"you"` when `sender_id` equals the frame owner's user id (the message's own `frame_owner_id`; if a message lacks it, the owner is found as the `is_owner` entry of `GET /frames/{f}/users`), otherwise the sender's email, which is how Skylight identifies senders outside the household. When the owner or the sender cannot be identified `from` is null, so the owner's email can never be returned. `sender_id` and `frame_owner_id` are user ids, the same ids as `relationships.user.data.id` in the frame users list [live fixtures].
- `DELETE /messages/destroy_multiple` reads `message_ids` from the JSON body [live 2026-10-12]: a DELETE with an empty body answers 422 "Message id is required" and the body form `{ message_ids: [numbers] }` is accepted. `skylight_delete_photos` sends exactly that body, is confirm-gated, and checks every id with `GET /messages/{id}` first (preview and confirm). `DELETE /messages/{id}` is [bundle] only and not used.
- Albums [live]: `GET /albums` returns `{ data: [{ id, type: "album_with_messages", attributes { title, kind, editable, exclude_from_slideshow, photos_count, videos_count, thumbnails }, relationships.messages.data }] }`. `POST /albums` `{ title }`, `PATCH /albums/{id}` `{ title }`, `DELETE /albums/{id}`, `GET /albums/{id}/messages`, `POST /albums/add_to` and `POST /albums/remove_from` with `{ album_ids: [n], message_ids: [n] }` (numbers). Albums with `editable: false` are refused by rename and delete.

### Devices [live unless marked]

- `GET /devices` and `GET /devices/{id}` return `attributes { name, timezone, activated, brightness (0-255), slideshow_speed, slideshow_style, start_sound, show_caption, show_heart, blur_effect, current_album_id (-1 = every photo), sleeps_at "HH:mm", wakes_at "HH:mm", currently_sleeping, sleep_mode_on, side_by_side, sleep_mode, sleep_sound, sleep_sound_volume, nightlight, nightlight_brightness, nightlight_color, notify_on_new_photos }`. The tools show `current_album_id` as `"all"` for -1.
- `PUT /devices/{id}` with a PARTIAL body leaves every other field untouched (verified: `show_heart` flipped while `brightness` and `sleeps_at` stayed). `{ name }` and `{ current_album_id }` work. `skylight_update_device` sends only the fields given (`buildDeviceUpdateBody`); ranges: brightness 0-255, slideshow speed 1-3600, style 0-10.
- `POST /devices/{id}/start_sleep` and `/end_sleep` [bundle]. `POST /devices/{id}/reset` and `DELETE /devices/{id}` [bundle, never live-tested]: both tools need the device's exact `confirmName` AND `confirm: true`.
- NOT built: alarms and sleep schedule blocks (this family's device answers 422 "Device must be a buddy device"), `device_config` (403 "Feature is not enabled for this device").

### Frame

- `GET /api/frames/{f}` [live] returns `attributes` including `name`, `timezone`, `household_name`, `locale`, `open_to_public`, `message_viewability`, `feature_bundle` (feature name to `{ enabled }`; the tool renames `meal_planning` to `meals`), `plus`, and fields the tools never return: `share_token`, `notification_email`, `owner_name`, `owner_birthday`, `hardware_model`, gift and trial fields.
- `PUT /api/frames/{f}` with any of `{ household_name, timezone, locale }` works [live: a no-op timezone]. `open_to_public` and `message_viewability` are accepted by Skylight too, but their vocabulary is unverified and a wrong value could publish the family's photos, so `skylight_update_frame` deliberately does not expose them (nor any other privacy field). Changing the frame's time zone does not change `SKYLIGHT_TIMEZONE`.
- NOT built: `PUT /frames/{f}/rename` (Skylight answers 422 "Contact support to rename this device") and `POST /frames/{f}/hide` (it would remove the frame from the account the server itself uses).

### Frame sharing

- `GET /frames/{f}/users` [live] returns `{ data: [{ id, type: "frame_user", attributes { status, is_owner }, relationships.user.data.id }], included: [{ id, type: "user", attributes { email } }] }`. `status` is `approved`, `rejected` (blocked) or `awaiting_approval` (`FRAME_USER_STATUS`).
- `POST /frames/{f}/users` `{ email }` invites (it SENDS AN EMAIL), `DELETE /frames/{f}/users/{userId}` blocks, `POST /frames/{f}/users/{userId}/approve` unblocks or approves [bundle, never live-tested]. `{userId}` is the id of the `user` (the `included` record and `relationships.user.data.id`), not the `frame_user` row id; the app's own user list passes it the same way and hides the owner. The invite, block and unblock tools read the list first (an address already on the frame, an unknown id, the owner and an already-blocked user are refused).

### Account

- `GET /api/user` [live] returns `attributes { subscription_status, agreed_to_marketing, notification_preference, ... }` plus personal fields (email, phone, birthday, profile name) that the tool never reads. `PATCH /api/user/klaviyo_toggler` with `{ agreed_to_marketing: boolean }` works [live, no-op].
- `GET /api/plus_access` [bundle] returns `{ data: { subscriptions: [{ type: "subscription", attributes { plus_type, status, ... } }], shares, bundle_entitlement } }`. `skylight_get_account` maps `plus_type` to `type` and reads `status` and `cadence` (null when absent); this response was not captured as a fixture, so the mapper is covered by an inline test only.
- NOT built: push-notification preferences (the value is null and its vocabulary is unknown).

### Calendar invites [bundle]

- Event create and update take `invited_emails: string[]`; Skylight emails each address an invitation. Not live-tested by design. The tools accept `invitedEmails` (0-20, validated, lower-cased, de-duplicated) and require `confirmInvites: true` when the list is non-empty. On update an empty list is validated but not sent: whether Skylight treats `[]` as "remove the invitees" is unknown, so clearing invitees is not exposed, and whether re-sending an already-invited address emails it again is unknown.

### Toolsets

- `SKYLIGHT_TOOLSETS` (comma list of `profiles, chores, rewards, lists, calendar, meals, photos, devices, frame, account`, default all) selects which tool groups register; `skylight_auth_status` is always registered. This is local configuration, not an API fact (`TOOLSETS` in `vocab.ts`).

## Verified chore semantics

Verified live on 2026-10-12 against app.ourskylight.com.

1. `POST /api/frames/{f}/chores/create_multiple` returns `{ data: [chore...] }`. Our `buildChoreCreateBody` works as-is, including `recurrence_set: ["RRULE:FREQ=DAILY"]` which comes back `recurring: true`.
2. Chore ids in list responses: the series' first occurrence has the plain numeric id (`"111881467"`); later occurrences of a recurring chore have composite ids `"111881467-2026-10-13"` (`<seriesId>-<YYYY-MM-DD>`). `attributes.series` always holds the numeric series id. `attributes.start` on a list row is the date of that OCCURRENCE (not the series start date).
   - Routine-step occurrences carry a time suffix: `<series>-<YYYY-MM-DD>-<HHMM>`, e.g. `60913118-2026-10-12-0600`. `attributes.start_time` is `"06:00"`, `"14:00"` or `"20:00"` and the rule carries `BYHOUR=6|14|20`. The completions path still takes the numeric series id, with `instance_date` and `instance_time` in the body.
3. `PUT /chores/{id}/completions`:
   - `{id}` MUST be the numeric series id. A composite id gives 422 `{"errors":{"id":["is not a number"]}}`.
   - Recurring chore: body `{ status, instance_date }` works. Omitting `instance_date` gives 422 `instance_date can't be blank`.
   - One-time chore: body `{ status }` only. Sending `instance_date` gives 422 `instance_date must be blank`.
   - Finding: `category_id` is rejected with 422 `category_id must be blank` for a chore assigned to a profile (both recurring and one-time). It is believed to be meant only for up-for-grabs chores, but that is unverified; the tool therefore sends it only when `profileId` is given.
   - `status` values: `"complete"` / `"pending"` (`CHORE_STATUS`).
4. `PUT /chores/{seriesId}` update: `apply_to` goes in the JSON body; works with `"all"` or omitted. A composite id in the path also worked for PUT, but the numeric series id is used for consistency. `one`/`future` on update are unverified and not exposed.
5. `DELETE /chores/{id}` with `apply_to` as a QUERY param:
   - One-time chore: no `apply_to` (sending one gives 400 `one-time chores should not have a value for apply_to`).
   - Recurring, path numeric series id + `?apply_to=all` deletes the whole series. Series id with no `apply_to` gives 400 `you must have a valid value for apply_to`.
   - Recurring, path composite id `<series>-<date>` + `?apply_to=one` deletes only that occurrence (verified).
   - Recurring, path composite id + `?apply_to=future` deletes that occurrence and all later ones (verified).
   - Routines are all-or-nothing: `DELETE /chores/<series>-<date>?apply_to=one` (and `future`) on a routine step returns 400 `{"message":"you may not edit a single instance of a routine"}`. Routine steps can only be deleted with `apply_to=all`; `one`/`future` apply to regular recurring chores only. The tool rejects `one`/`future` for time-suffixed ids before any request.
6. `GET /chores/{id}` returns 404 (no single-chore endpoint). The list is `GET /chores?after=&before=&include_late=true&include_up_for_grabs=true&filter=linked_to_profile`.
7. Chore attributes also include `description`, `timer_seconds`, `position`, `completed_at`, `completed_on` and `up_for_grabs`.
8. Routines (`routine: true`) on create:
   - `start_time` MUST be blank (422 `start_time must be blank`).
   - `recurrence_set` MUST be present (422 `cannot be empty for routines`) and MUST contain exactly one `BYHOUR` of 6, 14 or 20 (422 otherwise, including `BYHOUR=7`). The server derives each occurrence's `start_time` from it.
   - Non-routine chores MUST NOT have `BYHOUR` (422 `BYHOUR not allowed for non-routine chores`).
   - The tools expose this as `timeOfDay` (`morning` = 6, `afternoon` = 14, `evening` = 20; `ROUTINE_SLOTS` in `vocab.ts`).
9. Up-for-grabs chores: `category_ids: []` and `start: null` are both accepted. `relationships.category.data` is null; a claimed or finished one has `relationships.completed_category.data.id`. The list returns them only when `include_up_for_grabs=true`, with or without `filter=linked_to_profile`.

## Login verification

Verified live on 2026-10-12.

- PKCE `S256` is accepted by `/oauth/authorize` and `/oauth/token`.
- The token response includes `expires_in` (24 hours).
- The Keychain write via `/usr/bin/security` worked.
- The callback page `https://ourskylight.com/welcome?code=...` immediately JS-redirects to `https://ourskylight.com/`, so a person cannot copy the callback URL from the address bar. Chrome's History database (`~/Library/Application Support/Google/Chrome/<Profile>/History`, table `urls(url, last_visit_time)`, microseconds since 1601-01-01) does retain the `welcome?code=` URL. `skylight-mcp login` therefore reads it from a temporary copy of that database (the file is locked while Chrome runs) using `/usr/bin/sqlite3`. `skylight-mcp login --complete <url>` remains as the manual path.
