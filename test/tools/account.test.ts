import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");
const USER = { data: { id: "12311021", type: "user", attributes: { subscription_status: "plus", agreed_to_marketing: false, notification_preference: null, email: "me@example.com", phone: "+15555550123", birthday: "1980-01-01", profile: { name: "Jordan Example" }, email_mfa_enabled: false } } };
const PLUS = { data: { shares: [], subscriptions: [{ id: "9", type: "subscription", attributes: { plus_type: "cal_plus", status: "active", cadence: "yearly", customer_id: "cus_secret" } }], bundle_entitlement: { available: true } } };

test("get account returns the plan, subscriptions and marketing flag, and none of the personal data", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/user", json: USER }, { method: "GET", path: "/api/plus_access", json: PLUS }]);
  const r = await t.callTool("skylight_get_account");
  assert.deepEqual(r.data, { plan: "plus", plusSubscriptions: [{ status: "active", cadence: "yearly", type: "cal_plus" }], marketingEmails: false });
  for (const secret of ["me@example.com", "5555550123", "1980-01-01", "Jordan Example", "cus_secret", "12311021"]) assert.ok(!r.text.includes(secret), secret);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("get account still answers when plus_access fails, saying the subscriptions are unknown", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/user", json: USER }, { method: "GET", path: "/api/plus_access", status: 500, text: "boom" }]);
  const r = await t.callTool("skylight_get_account");
  assert.equal(r.isError, false);
  const d = r.data as { plan: string; plusSubscriptions: unknown; warning: string };
  assert.deepEqual([d.plan, d.plusSubscriptions], ["plus", null]);
  assert.match(d.warning, /subscriptions/i);
  await t.close();
});

test("set marketing emails PATCHes the klaviyo toggler with { agreed_to_marketing }", async () => {
  const t = await connectTestClient([FRAMES, { method: "PATCH", path: "/api/user/klaviyo_toggler", json: {} }]);
  assert.deepEqual((await t.callTool("skylight_set_marketing_emails", { enabled: true })).data, { marketingEmails: true });
  assert.deepEqual((await t.callTool("skylight_set_marketing_emails", { enabled: false })).data, { marketingEmails: false });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["PATCH", "/api/user/klaviyo_toggler", { agreed_to_marketing: true }], ["PATCH", "/api/user/klaviyo_toggler", { agreed_to_marketing: false }]]);
  assert.equal((await t.callTool("skylight_set_marketing_emails", {})).isError, true);
  assert.equal((await t.callTool("skylight_set_marketing_emails", { enabled: "yes" })).isError, true);
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("account tools are annotated and there is no push-preference or personal-data tool", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  assert.equal(tools.get("skylight_get_account")!.annotations!.readOnlyHint, true);
  assert.equal(tools.get("skylight_set_marketing_emails")!.annotations!.idempotentHint, true);
  assert.ok(![...tools.keys()].some((n) => /push|notification/.test(n)));
  await t.close();
});
