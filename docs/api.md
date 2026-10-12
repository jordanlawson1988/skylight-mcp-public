# Observed Skylight API (unofficial)

Everything here is observed from the Skylight web app (`https://ourskylight.com`, Expo bundle
`_expo/static/js/web/index-*.js`) and the reference project's HAR capture on 2026-10-12.
Nothing is guaranteed by Skylight.

## Hosts and headers

- API: `https://app.ourskylight.com`
- `Authorization: Bearer <access token>`, `accept: application/json`, `Skylight-Api-Version: 2026-05-01`
- OAuth: `/oauth/authorize` requires a Skylight server-side login session (`/auth/session/new`);
  the web app's own localStorage token does not satisfy it. PKCE S256 is sent on authorize and
  `code_verifier` on `/oauth/token`. (Exchange verified: see "Login verification" below.)

## Frames and profiles

- `GET /api/frames/calendar` → `{ data: [{ id, attributes: { name?, household_name? } }] }`
- Profiles are categories: `GET /api/frames/{frameId}/categories`.
  Attribute names used by the web app: `label` (display name), `color`, `emoji`,
  `selected_for_chore_chart`. No adult/child flag was found in the bundle; `isAdult` stays null.

## Chores and routines

- List: `GET /api/frames/{frameId}/chores?after=&before=&include_late=&include_up_for_grabs=&filter=linked_to_profile`
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

## Login verification

Pending. The PKCE exchange and the Keychain write path are verified by the first real
`skylight-mcp login` on this machine; results are recorded here when that runs.
