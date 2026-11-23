// Runs against a fresh `wrangler dev` database. API_URL defaults to localhost:8787.
import assert from "node:assert/strict";

const API = process.env.API_URL || "http://127.0.0.1:8787";
const INVITE = process.env.INVITE_CODE || "TEST-CODE";
const ORIGIN = "https://secretsanta.mph.sh";

async function call(method, path, token, body) {
  const headers = { Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
}
const phase = (token, action, extra = {}) => call("POST", "/api/admin/phase", token, { action, ...extra });

// Access control before joining
assert.equal((await call("GET", "/api/me")).status, 401);
assert.equal((await call("POST", "/api/register", null, { invite: "NOPE", name: "X", household: "Y", password: "password1" })).status, 403);
const preflight = await fetch(`${API}/api/me`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
assert.equal(preflight.headers.get("access-control-allow-origin"), null);

// Households are only listed with a valid invite, and must be chosen from the list
assert.equal((await call("POST", "/api/households", null, { invite: "NOPE" })).status, 403);
assert.deepEqual((await call("POST", "/api/households", null, { invite: INVITE })).data.households, ["Oak", "Elm", "Ash"]);
assert.equal((await call("POST", "/api/register", null, { invite: INVITE, name: "Mallory", email: "mallory@example.com", household: "Made Up", password: "password1" })).status, 400);
assert.equal((await call("POST", "/api/register", null, { invite: INVITE, name: "Mallory", email: "not-an-email", household: "Oak", password: "password1" })).status, 400);

const family = [["Ann", "Oak"], ["Bob", "Oak"], ["Cy", "Elm"], ["Di", "Elm"], ["Ed", "Ash"], ["Flo", "Ash"]];
const tokens = {};
for (const [name, household] of family) {
  const result = await call("POST", "/api/register", null, { invite: INVITE.toLowerCase(), name, email: ` ${name}@Example.com `, household, password: "password1" });
  assert.equal(result.status, 200, name);
  tokens[name] = result.data.token;
}
assert.equal((await call("POST", "/api/register", null, { invite: INVITE, name: "ann", email: "other@example.com", household: "Oak", password: "password1" })).status, 409);
assert.equal((await call("POST", "/api/register", null, { invite: INVITE, name: "Other", email: "ANN@example.com", household: "Oak", password: "password1" })).status, 409);

const annStart = (await call("GET", "/api/me", tokens.Ann)).data;
assert.equal(annStart.me.isOrganiser, true);
assert.equal(annStart.inviteCode, INVITE);
const bobStart = (await call("GET", "/api/me", tokens.Bob)).data;
assert.equal(bobStart.me.isOrganiser, false);
assert.equal(bobStart.inviteCode, undefined);

// Phase rules
assert.equal((await call("PUT", "/api/notes", tokens.Bob, { notes: "early" })).status, 409);
assert.equal((await phase(tokens.Bob, "close")).status, 403);
assert.equal((await phase(tokens.Ann, "close")).status, 200);
assert.equal((await call("POST", "/api/register", null, { invite: INVITE, name: "Late", household: "Oak", password: "password1" })).status, 403);

// Notes
for (const [name] of family) {
  assert.equal((await call("PUT", "/api/notes", tokens[name], { notes: `<b>wish-${name}</b>` })).status, 200);
}

// Password reset: old login fails, temporary login reveals nothing until changed
const bobId = bobStart.me.id;
const reset = await call("POST", "/api/admin/reset", tokens.Ann, { id: bobId });
assert.equal(reset.status, 200);
assert.equal((await call("GET", "/api/me", tokens.Bob)).status, 401);
assert.equal((await call("POST", "/api/login", null, { email: "bob@example.com", password: "password1" })).status, 401);
const temp = await call("POST", "/api/login", null, { email: "BOB@example.com", password: reset.data.temporary });
assert.equal(temp.status, 200);
tokens.Bob = temp.data.token;

// The draw
assert.equal((await phase(tokens.Bob, "draw")).status, 403);
assert.equal((await phase(tokens.Ann, "draw")).status, 200);
assert.equal((await phase(tokens.Ann, "draw")).status, 409);

const locked = (await call("GET", "/api/me", tokens.Bob)).data;
assert.deepEqual(Object.keys(locked), ["me"]);
assert.equal((await call("PUT", "/api/notes", tokens.Bob, { notes: "x" })).status, 403);
assert.equal((await call("POST", "/api/password", tokens.Bob, { password: "brandnew1" })).status, 200);

const households = Object.fromEntries(family.map(([n, h]) => [n, h.trim().toLowerCase()]));
const received = new Set();
for (const [name] of family) {
  const { status, data } = await call("GET", "/api/me", tokens[name]);
  assert.equal(status, 200);
  assert.notEqual(households[name], households[data.match.name], `${name} got own household`);
  assert.equal(data.match.notes, `<b>wish-${data.match.name}</b>`);
  received.add(data.match.name);
  assert.ok(!JSON.stringify(data).toLowerCase().includes("@example.com"), "email exposed");
  const leaked = new Set(JSON.stringify(data).match(/wish-\w+/g));
  assert.deepEqual(leaked, new Set([`wish-${name}`, `wish-${data.match.name}`]), `${name} saw other notes`);
  for (const person of data.people) assert.deepEqual(Object.keys(person).sort(), ["hasNotes", "household", "id", "name"]);
}
assert.equal(received.size, family.length);

// Undo guard, removal guard, logout
assert.equal((await call("POST", "/api/admin/remove", tokens.Ann, { id: bobId })).status, 409);
assert.equal((await phase(tokens.Ann, "undo")).status, 409);
assert.equal((await phase(tokens.Ann, "undo", { confirm: true })).status, 200);
assert.equal((await call("GET", "/api/me", tokens.Di)).data.match, null);
assert.equal((await call("POST", "/api/logout", tokens.Di)).status, 200);
assert.equal((await call("GET", "/api/me", tokens.Di)).status, 401);

// Login throttle
for (let i = 0; i < 10; i++) assert.equal((await call("POST", "/api/login", null, { email: "flo@example.com", password: "wrongpass" })).status, 401);
assert.equal((await call("POST", "/api/login", null, { email: "flo@example.com", password: "password1" })).status, 429);

console.log("e2e passed");
