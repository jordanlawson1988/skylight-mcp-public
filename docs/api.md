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

- `GET /calendar_events?date_min=YYYY-MM-DD&date_max=YYYY-MM-DD` (both required) returns `{ data: [event], included: [category, calendar_account] }`. Attributes: `uid, summary, invited_emails, status, all_day, timezone, starts_at, ends_at, recurring, recurring_config, rrule ([string] | null), master_event_id, description, location, lat, lng, source ("skylight", "google", ...), kind ("standard"), editable, countdown_enabled, emoji_icon, owner_email, calendar_id`; `relationships.category.data.id`. Occurrences of a recurring event have composite ids `<masterId>-<unixSeconds>`.
- Create: `POST /calendar_events` with `{ summary, kind: "standard", category_ids, starts_at, ends_at, all_day, rrule: ["RRULE:..."] | null, invited_emails: [], location, lat, lng, description, emoji_icon, calendar_account_id: null, calendar_id: null, timezone, countdown_enabled }`.
- TIME ZONES: a `starts_at` without an offset is treated as UTC. With an explicit offset (`2026-10-12T18:30:00-04:00`) the local time is kept and echoed as `2026-10-12T18:30:00.000-04:00`. The tools therefore require an offset (`assertDateTimeWithOffset`) and refuse bare datetimes. All-day events send `starts_at`/`ends_at` as `YYYY-MM-DD` with `all_day: true`; a single-day all-day event has `ends_at` equal to `starts_at`.
- Update: `PUT /calendar_events/{id}` with any of the create fields plus `apply_to`. The tool sends the master id and only exposes `apply_to: "all"`, as for chores.
- Delete: `DELETE /calendar_events/{id}?apply_to=one|future|all`. Verified: a composite occurrence id with `one` removes that occurrence; a composite id with `future` removes it and later ones; a master id with no `apply_to` removes the whole series. The response is `{ meta: { destroyed_id } }`.
- Synced calendars: events whose `source` is not `skylight` (80 Google events in a two-week window on the test frame) live on the frame too. The update and delete tools look the event up in a listing (a 3-day window around an occurrence, or a year either side of today for a plain id) and refuse with "this event comes from a synced <source> calendar; change it there". A lookup that finds nothing or fails lets the request through, so the server decides.

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
