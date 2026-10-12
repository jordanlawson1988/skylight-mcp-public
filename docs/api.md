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
  `selected_for_chore_chart`. No adult/child flag was found in the bundle; `isAdult` stays null.

## Chores and routines

- List: `GET /api/frames/{frameId}/chores?after=&before=&include_late=&include_up_for_grabs=&filter=linked_to_profile`
  (the MCP tool `skylight_list_chores` sends `include_late=false` unless `includeLate: true` is passed, because late occurrences go back months and a live run returned 608 chores; results are sorted by `instanceDate`, nulls last, then summary.)
- Create: `POST /api/frames/{frameId}/chores/create_multiple` with
  `{ summary, start, start_time, routine, up_for_grabs, recurrence_set, recurring_until, category_ids, reward_points, emoji_icon }`
- Update: `PUT /api/frames/{frameId}/chores/{id}` with the same attributes plus
  `apply_to`, `apply_to_profiles`, `category_ids`, `after`, `before` (web app `updateChore`).
- Delete: `DELETE /api/frames/{frameId}/chores/{id}` with body/query `{ apply_to, apply_to_profiles }`.
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

- `GET /api/frames/{frameId}/rewards`, `GET /api/frames/{frameId}/reward_points`
- `POST /api/frames/{frameId}/reward_points` with `{ category_ids, points }` (negative subtracts).

## Verified chore semantics

Verified live on 2026-10-12 against app.ourskylight.com.

1. `POST /api/frames/{f}/chores/create_multiple` returns `{ data: [chore...] }`. Our `buildChoreCreateBody` works as-is, including `recurrence_set: ["RRULE:FREQ=DAILY"]` which comes back `recurring: true`.
2. Chore ids in list responses: the series' first occurrence has the plain numeric id (`"111881467"`); later occurrences of a recurring chore have composite ids `"111881467-2026-10-13"` (`<seriesId>-<YYYY-MM-DD>`). `attributes.series` always holds the numeric series id. `attributes.start` is the series start date.
3. `PUT /chores/{id}/completions`:
   - `{id}` MUST be the numeric series id. A composite id gives 422 `{"errors":{"id":["is not a number"]}}`.
   - Recurring chore: body `{ status, instance_date }` works. Omitting `instance_date` gives 422 `instance_date can't be blank`.
   - One-time chore: body `{ status }` only. Sending `instance_date` gives 422 `instance_date must be blank`.
   - `category_id` gives 422 `category_id must be blank` for a chore assigned to a profile (both recurring and one-time). It is only for up-for-grabs chores (unverified; keep it optional and only send when given).
   - `status` values: `"complete"` / `"pending"` (`CHORE_STATUS`).
4. `PUT /chores/{seriesId}` update: `apply_to` goes in the JSON body; works with `"all"` or omitted. A composite id in the path also worked for PUT, but the numeric series id is used for consistency. `one`/`future` on update are unverified and not exposed.
5. `DELETE /chores/{id}` with `apply_to` as a QUERY param:
   - One-time chore: no `apply_to` (sending one gives 400 `one-time chores should not have a value for apply_to`).
   - Recurring, path numeric series id + `?apply_to=all` deletes the whole series. Series id with no `apply_to` gives 400 `you must have a valid value for apply_to`.
   - Recurring, path composite id `<series>-<date>` + `?apply_to=one` deletes only that occurrence (verified).
   - Recurring, path composite id + `?apply_to=future` deletes that occurrence and all later ones (verified).
6. `GET /chores/{id}` returns 404 (no single-chore endpoint). The list is `GET /chores?after=&before=&include_late=true&include_up_for_grabs=true&filter=linked_to_profile`.

## Login verification

Verified live on 2026-10-12.

- PKCE `S256` is accepted by `/oauth/authorize` and `/oauth/token`.
- The token response includes `expires_in` (24 hours).
- The Keychain write via `/usr/bin/security` worked.
- The callback page `https://ourskylight.com/welcome?code=...` immediately JS-redirects to `https://ourskylight.com/`, so a person cannot copy the callback URL from the address bar. Chrome's History database (`~/Library/Application Support/Google/Chrome/<Profile>/History`, table `urls(url, last_visit_time)`, microseconds since 1601-01-01) does retain the `welcome?code=` URL. `skylight-mcp login` therefore reads it from a temporary copy of that database (the file is locked while Chrome runs) using `/usr/bin/sqlite3`. `skylight-mcp login --complete <url>` remains as the manual path.
