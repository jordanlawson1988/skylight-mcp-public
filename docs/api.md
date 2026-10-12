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
- Reorder routine steps: `POST .../chores/{id}/reorder` style call exists (`reorderRoutine` with before/after). Not exposed in v1.

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
   - For a routine-step occurrence (`<series>-<date>-<HHMM>`) the tool sends the date-only `<series>-<date>` path; whether the time is also needed is checked by the live smoke.
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
