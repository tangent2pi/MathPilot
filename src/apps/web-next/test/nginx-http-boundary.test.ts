import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isProblemDetails } from "@mathpilot/contracts";

const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
};

const securityHeaders = [
  "x-content-type-options",
  "referrer-policy",
  "x-frame-options",
  "permissions-policy",
  "content-security-policy",
] as const;

test("Nginx owns security headers, flood limiting and ingress-generated Problems", { timeout: 30_000 }, async () => {
  let upstreamRequests = 0;
  const observedRealIps = new Set<string>();
  const upstreamProblem = JSON.stringify({
    type: "urn:mathpilot:problem:upstream-limit",
    title: "Upstream business limit",
    status: 429,
    code: "upstream_limit",
  });
  const upstream = createServer((request, response) => {
    upstreamRequests += 1;
    observedRealIps.add(String(request.headers["x-real-ip"]));
    response.setHeader("x-content-type-options", "off");
    response.setHeader("referrer-policy", "unsafe-url");
    response.setHeader("x-frame-options", "ALLOWALL");
    response.setHeader("permissions-policy", "camera=*");
    response.setHeader("content-security-policy", "default-src * 'unsafe-inline'");
    response.setHeader("access-control-allow-origin", "*");
    if (request.url === "/api/upstream-429") {
      response.writeHead(429, { "content-type": "application/problem+json", "retry-after": "9" });
      response.end(upstreamProblem);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const probe = createServer();
  const nginxPort = await listen(probe);
  probe.close(); await once(probe, "close");

  const temporary = await mkdtemp(path.join(tmpdir(), "mathpilot-nginx-boundary-"));
  await mkdir(path.join(temporary, "html"));
  await writeFile(path.join(temporary, "html", "index.html"), "<!doctype html><title>MathPilot</title>");
  const template = await readFile(new URL("../nginx.conf", import.meta.url), "utf8");
  const serverConfig = template
    .replace("listen 80;", `listen 127.0.0.1:${nginxPort};`)
    .replace("/usr/share/nginx/html", path.join(temporary, "html"))
    .replace("http://api:3101", `http://127.0.0.1:${upstreamPort}`)
    .replace("client_max_body_size 32m;", "client_max_body_size 1k;")
    .replaceAll("${MINIO_PUBLIC_ENDPOINT}", "http://127.0.0.1:9000")
    .replace("${MATHPILOT_API_RATE}", "30r/s")
    .replace("${MATHPILOT_API_BURST}", "60");
  const configPath = path.join(temporary, "nginx.conf");
  await writeFile(configPath, `pid ${path.join(temporary, "nginx.pid")};\nerror_log stderr notice;\nevents {}\nhttp {\naccess_log off;\n${serverConfig}\n}\n`);

  const syntax = spawnSync("nginx", ["-t", "-p", `${temporary}/`, "-c", configPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `${syntax.stdout}\n${syntax.stderr}`);
  const nginx = spawn("nginx", ["-p", `${temporary}/`, "-c", configPath, "-g", "daemon off;"], { stdio: ["ignore", "ignore", "pipe"] });
  let nginxErrors = "";
  nginx.stderr.setEncoding("utf8"); nginx.stderr.on("data", (chunk) => { nginxErrors += chunk; });
  try {
    let normal: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { normal = await fetch(`http://127.0.0.1:${nginxPort}/api/ok`); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(normal, nginxErrors);
    assert.equal(normal.status, 200);
    assert.equal(normal.headers.get("x-content-type-options"), "nosniff");
    assert.equal(normal.headers.get("referrer-policy"), "same-origin");
    assert.equal(normal.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(normal.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    for (const header of securityHeaders) assert.ok(normal.headers.get(header), `${header} missing from normal response`);
    assert.equal(normal.headers.has("access-control-allow-origin"), false);
    const csp = normal.headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);

    const upstream429 = await fetch(`http://127.0.0.1:${nginxPort}/api/upstream-429`);
    assert.equal(upstream429.status, 429);
    assert.equal(upstream429.headers.get("retry-after"), "9");
    assert.equal(await upstream429.text(), upstreamProblem);

    const beforeOversized = upstreamRequests;
    const oversized = await fetch(`http://127.0.0.1:${nginxPort}/api/oversized`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2_048),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("cache-control"), "no-store");
    assert.match(oversized.headers.get("content-type") ?? "", /^application\/problem\+json/);
    const oversizedProblem: unknown = await oversized.json();
    assert.equal(isProblemDetails(oversizedProblem), true);
    assert.equal((oversizedProblem as { code: string }).code, "request_body_too_large");
    for (const header of securityHeaders) assert.ok(oversized.headers.get(header), `${header} missing from 413`);
    assert.equal(upstreamRequests, beforeOversized, "Nginx forwarded an oversized request to the protected upstream");

    const beforeFlood = upstreamRequests;
    const flood = await Promise.all(Array.from({ length: 120 }, (_, index) => fetch(
      `http://127.0.0.1:${nginxPort}/api/flood`,
      { headers: { "x-real-ip": `198.51.100.${index % 200}`, "x-forwarded-for": `203.0.113.${index % 200}` } },
    )));
    const rejected = flood.filter((response) => response.status === 429);
    assert.ok(rejected.length > 0, "flood limiter did not reject any request");
    assert.ok(upstreamRequests - beforeFlood < flood.length, "rejected flood requests still reached the upstream");
    assert.deepEqual([...observedRealIps], ["127.0.0.1"]);
    const limited = rejected[0]!;
    assert.equal(limited.headers.get("retry-after"), "1");
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.match(limited.headers.get("content-type") ?? "", /^application\/problem\+json/);
    const limitedProblem: unknown = await limited.json();
    assert.equal(isProblemDetails(limitedProblem), true);
    assert.equal((limitedProblem as { code: string }).code, "request_rate_exceeded");
    for (const header of securityHeaders) assert.ok(limited.headers.get(header), `${header} missing from 429`);
    await Promise.all(flood.filter((response) => response !== limited).map((response) => response.arrayBuffer()));

    upstream.close(); await once(upstream, "close");
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const gateway = await fetch(`http://127.0.0.1:${nginxPort}/api/unavailable`);
    assert.equal(gateway.status, 502);
    assert.equal(gateway.headers.get("cache-control"), "no-store");
    assert.match(gateway.headers.get("content-type") ?? "", /^application\/problem\+json/);
    const gatewayProblem: unknown = await gateway.json();
    assert.equal(isProblemDetails(gatewayProblem), true);
    assert.equal((gatewayProblem as { code: string }).code, "gateway_unavailable");
    for (const header of securityHeaders) assert.ok(gateway.headers.get(header), `${header} missing from gateway Problem`);
  } finally {
    if (upstream.listening) { upstream.close(); await once(upstream, "close"); }
    if (nginx.exitCode === null && nginx.signalCode === null) {
      nginx.kill("SIGTERM");
      await once(nginx, "exit");
    }
  }
});
