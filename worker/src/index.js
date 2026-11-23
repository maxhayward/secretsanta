import { DrawError, makeDraw } from "./draw.js";

// Cloudflare Workers caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;
const SESSION_SECONDS = 60 * 60 * 24 * 45;
const MAX_BODY = 16 * 1024;
const MAX_NOTES = 2000;
const MAX_LABEL = 40;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60;
const PHASE = "(SELECT value FROM settings WHERE key = 'phase')";

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const clean = (value) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");
const keyFor = (value) => clean(value).toLocaleLowerCase("en-GB");
const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(await derive(password, salt, PBKDF2_ITERATIONS))}`;
}

async function checkPassword(password, stored) {
  const [iterations, salt, digest] = stored.split("$");
  const actual = await derive(password, fromB64(salt), Number(iterations));
  const expected = fromB64(digest);
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] || 0) ^ (right[i] || 0);
  return difference === 0;
}

function randomToken() {
  return toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function temporaryPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const limit = 256 - (256 % alphabet.length);
  let result = "";
  while (result.length < 10) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    if (byte < limit) result += alphabet[byte % alphabet.length];
  }
  return result;
}

const getPhase = async (env) =>
  (await env.DB.prepare("SELECT value FROM settings WHERE key = 'phase'").first("value"));

async function throttled(env, key) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at > ?")
    .bind(key, now() - FAILURE_WINDOW).first();
  return row.n >= MAX_FAILURES;
}

const recordFailure = (env, key) =>
  env.DB.batch([
    env.DB.prepare("DELETE FROM attempts WHERE at <= ?").bind(now() - FAILURE_WINDOW),
    env.DB.prepare("INSERT INTO attempts (key, at) VALUES (?, ?)").bind(key, now()),
  ]);

const clearFailures = (env, key) => env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(key).run();

async function createSession(env, personId) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires <= ?").bind(now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, person_id, expires) VALUES (?, ?, ?)")
      .bind(await sha256(token), personId, now() + SESSION_SECONDS),
  ]);
  return token;
}

async function authenticate(request, env) {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
  if (!match) throw new ApiError(401, "Please log in.");
  const tokenHash = await sha256(match[1]);
  const person = await env.DB.prepare(
    `SELECT p.* FROM sessions s JOIN people p ON p.id = s.person_id WHERE s.token_hash = ? AND s.expires > ?`,
  ).bind(tokenHash, now()).first();
  if (!person) throw new ApiError(401, "Please log in.");
  return { person, tokenHash };
}

function validPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new ApiError(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
  }
}

async function register(request, env, body) {
  const name = clean(body.name);
  const household = clean(body.household);
  const key = `${request.headers.get("CF-Connecting-IP") || "local"}:invite`;
  if ((await getPhase(env)) !== "register") throw new ApiError(403, "Registration is closed.");
  if (await throttled(env, key)) throw new ApiError(429, "Too many attempts. Please try again in 15 minutes.");
  if (!sameText(clean(body.invite).toUpperCase(), env.INVITE_CODE.toUpperCase())) {
    await recordFailure(env, key);
    throw new ApiError(403, "That invite code isn't right.");
  }
  if (!name || !household || name.length > MAX_LABEL || household.length > MAX_LABEL) {
    throw new ApiError(400, `Name and household are required, up to ${MAX_LABEL} characters.`);
  }
  validPassword(body.password);
  const hashed = await hashPassword(body.password);
  let result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO people (name, name_key, household, household_key, password, is_organiser)
       SELECT ?, ?, ?, ?, ?, (SELECT COUNT(*) = 0 FROM people) WHERE ${PHASE} = 'register'`,
    ).bind(name, keyFor(name), household, keyFor(household), hashed).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new ApiError(409, "Someone with that name has already joined. Add a surname or initial.");
    }
    throw error;
  }
  if (!result.meta.changes) throw new ApiError(403, "Registration is closed.");
  return { token: await createSession(env, result.meta.last_row_id) };
}

async function login(request, env, body) {
  const name = clean(body.name);
  const password = typeof body.password === "string" ? body.password : "";
  const key = `${request.headers.get("CF-Connecting-IP") || "local"}:${keyFor(name)}`;
  if (await throttled(env, key)) throw new ApiError(429, "Too many attempts. Please try again in 15 minutes.");
  const person = await env.DB.prepare("SELECT id, password FROM people WHERE name_key = ?").bind(keyFor(name)).first();
  // Unknown names still do the hashing work, so response times don't reveal who has joined.
  const stored = person?.password || `${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
  const valid = password.length <= MAX_PASSWORD && (await checkPassword(password, stored));
  if (!person || !valid) {
    await recordFailure(env, key);
    throw new ApiError(401, "That name and password don't match.");
  }
  await clearFailures(env, key);
  return { token: await createSession(env, person.id) };
}

async function state(env, person) {
  const me = {
    id: person.id,
    name: person.name,
    household: person.household,
    notes: person.notes,
    isOrganiser: !!person.is_organiser,
    mustChange: !!person.must_change,
  };
  if (me.mustChange) return { me: { name: me.name, mustChange: true } };
  const phase = await getPhase(env);
  const { results } = await env.DB.prepare(
    "SELECT id, name, household, notes <> '' AS has_notes FROM people ORDER BY household_key, name_key",
  ).all();
  const people = results.map((p) => ({
    id: p.id,
    name: p.name,
    household: p.household,
    hasNotes: phase === "register" ? undefined : !!p.has_notes,
  }));
  let match = null;
  if (phase === "drawn") {
    match = await env.DB.prepare(
      `SELECT p.name, p.notes FROM assignments a JOIN people p ON p.id = a.receiver_id WHERE a.giver_id = ?`,
    ).bind(person.id).first();
  }
  const response = { me, phase, people, match };
  if (me.isOrganiser && phase === "register") response.inviteCode = env.INVITE_CODE;
  return response;
}

async function changePhase(env, action, confirm) {
  const move = (from, to) =>
    env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'phase' AND value = ?").bind(to, from);
  const phase = await getPhase(env);

  if (action === "close" && phase === "register") {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first();
    if (n < 3) throw new ApiError(400, "You need at least 3 people before closing sign-ups.");
    await move("register", "notes").run();
  } else if (action === "reopen" && phase === "notes") {
    await move("notes", "register").run();
  } else if (action === "draw" && phase === "notes") {
    const { results } = await env.DB.prepare("SELECT id, household_key AS household FROM people").all();
    let pairs;
    try {
      pairs = makeDraw(results);
    } catch (error) {
      if (error instanceof DrawError) throw new ApiError(400, error.message);
      throw error;
    }
    // One atomic batch: inserts only apply if this request won the move to "drawn".
    const insert = env.DB.prepare(
      `INSERT INTO assignments (giver_id, receiver_id) SELECT ?, ? WHERE ${PHASE} = 'drawn'`,
    );
    const [moved] = await env.DB.batch([move("notes", "drawn"), ...pairs.map((pair) => insert.bind(...pair))]);
    if (!moved.meta.changes) throw new ApiError(409, "The draw has already changed. Refresh and try again.");
  } else if (action === "undo" && phase === "drawn" && confirm === true) {
    await env.DB.batch([env.DB.prepare("DELETE FROM assignments"), move("drawn", "notes")]);
  } else {
    throw new ApiError(409, "That step isn't available right now. Refresh and try again.");
  }
  return { ok: true };
}

async function targetFor(env, person, id) {
  if (!Number.isInteger(id) || id === person.id) throw new ApiError(400, "Choose another person.");
  const target = await env.DB.prepare("SELECT id, name FROM people WHERE id = ?").bind(id).first();
  if (!target) throw new ApiError(404, "That person no longer exists.");
  return target;
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  let body = {};
  if (request.method === "POST" || request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new ApiError(413, "That's too long.");
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(400, "Invalid request.");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Invalid request.");
  }

  if (route === "POST /api/register") return register(request, env, body);
  if (route === "POST /api/login") return login(request, env, body);

  const { person, tokenHash } = await authenticate(request, env);
  if (route === "GET /api/me") return state(env, person);
  if (route === "POST /api/logout") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return { ok: true };
  }
  if (route === "POST /api/password") {
    validPassword(body.password);
    const hashed = await hashPassword(body.password);
    await env.DB.batch([
      env.DB.prepare("UPDATE people SET password = ?, must_change = 0 WHERE id = ?").bind(hashed, person.id),
      env.DB.prepare("DELETE FROM sessions WHERE person_id = ? AND token_hash <> ?").bind(person.id, tokenHash),
    ]);
    return { ok: true };
  }
  if (person.must_change) throw new ApiError(403, "Please choose a new password first.");

  if (route === "PUT /api/notes") {
    if (typeof body.notes !== "string") throw new ApiError(400, "Invalid notes.");
    const notes = body.notes.replace(/\r\n/g, "\n").trim();
    if (notes.length > MAX_NOTES) throw new ApiError(400, `Notes must be under ${MAX_NOTES} characters.`);
    const result = await env.DB.prepare(`UPDATE people SET notes = ? WHERE id = ? AND ${PHASE} <> 'register'`)
      .bind(notes, person.id).run();
    if (!result.meta.changes) throw new ApiError(409, "Notes open once sign-ups close.");
    return { ok: true };
  }

  if (pathname.startsWith("/api/admin/")) {
    if (!person.is_organiser) throw new ApiError(403, "Only the organiser can do that.");
    if (route === "POST /api/admin/phase") return changePhase(env, body.action, body.confirm);
    if (route === "POST /api/admin/remove") {
      const target = await targetFor(env, person, body.id);
      const result = await env.DB.prepare(`DELETE FROM people WHERE id = ? AND ${PHASE} <> 'drawn'`).bind(target.id).run();
      if (!result.meta.changes) throw new ApiError(409, "Undo the draw before removing someone.");
      return { ok: true };
    }
    if (route === "POST /api/admin/reset") {
      const target = await targetFor(env, person, body.id);
      const temporary = temporaryPassword();
      const hashed = await hashPassword(temporary);
      await env.DB.batch([
        env.DB.prepare("UPDATE people SET password = ?, must_change = 1 WHERE id = ?").bind(hashed, target.id),
        env.DB.prepare("DELETE FROM sessions WHERE person_id = ?").bind(target.id),
      ]);
      return { name: target.name, temporary };
    }
  }
  throw new ApiError(404, "Not found.");
}

function corsHeaders(request, env) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  };
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim());
  const origin = request.headers.get("Origin");
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      return Response.json(await route(request, env), { headers });
    } catch (error) {
      if (error instanceof ApiError) {
        return Response.json({ error: error.message }, { status: error.status, headers });
      }
      console.error("Unhandled error", error?.name);
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 500, headers });
    }
  },
};
