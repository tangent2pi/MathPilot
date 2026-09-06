// Online read-only regression: authentication and current application routes.
// Only sign-in/sign-out mutate session state; no model calls or learning writes.
import assert from "node:assert/strict";

const base = (process.env.BASE ?? "http://localhost:8080").replace(/\/$/, "");
const credentials = ["STUDENT", "TEACHER"].map(role => {
  const email = process.env[`BETTER_AUTH_${role}_EMAIL`];
  const password = process.env[`BETTER_AUTH_${role}_PASSWORD`];
  assert.ok(email && password, `Set BETTER_AUTH_${role}_EMAIL and BETTER_AUTH_${role}_PASSWORD`);
  return { role: role.toLowerCase(), email, password };
});

async function request(path, { cookie, body } = {}) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
}

assert.equal((await request("/")).status, 200, "Web entry");
assert.equal((await request("/api/me")).status, 401, "Anonymous identity access");
assert.equal((await request("/api/learning/threads")).status, 401, "Anonymous thread access");
for (const { role, email, password } of credentials) {
  const login = await request("/api/auth/sign-in/email", { body: { email, password, rememberMe: false } });
  assert.equal(login.status, 200, `${role} sign-in`);
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.ok(cookie, `${role} session cookie`);
  try {
    const me = await request("/api/me", { cookie });
    assert.equal(me.status, 200);
    assert.ok((await me.json()).roles.includes(role), `${role} identity`);
    const paths = role === "student"
      ? ["/api/learning/threads", "/api/learning/me/overview", "/api/learning/me/history", "/api/learning/self-test/knowledge-tree"]
      : ["/api/learning/teacher/students", "/api/content/packages", "/api/content/candidates"];
    for (const path of paths) {
      const response = await request(path, { cookie });
      assert.equal(response.status, 200, `${role} ${path}`);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/, path);
      await response.json();
    }
    if (role === "student") {
      assert.equal((await request("/api/learning/teacher/students", { cookie })).status, 403, "Teacher route isolation");
    }
    console.log(`PASS ${role}: identity, authorized reads and role boundaries`);
  } finally {
    const logout = await request("/api/auth/sign-out", { cookie, body: {} });
    assert.equal(logout.status, 200, `${role} sign-out`);
  }
}
console.log("CURRENT STATE SMOKE PASS");
