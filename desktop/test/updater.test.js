// Run with: node test/updater.test.js
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createUpdater, newer } = require("../updater");

(async () => {
  assert(newer("0.4.1", "0.4.0") && newer("1.0.0", "0.9.9") && !newer("0.4.0", "0.4.0") && !newer("0.3.9", "0.4.0"));
  const payload = Buffer.from("pretend installer " + "x".repeat(5000));
  const good = crypto.createHash("sha512").update(payload).digest("hex");
  let latest = { version: "0.5.0", file: "Ocean-Setup-0.5.0.exe", size: payload.length, sha512: good };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/ocean/latest.json")) { res.end(JSON.stringify(latest)); return; }
    if (req.url === "/ocean/Ocean-Setup-0.5.0.exe") { res.end(payload); return; }
    if (req.url === "/ocean/Ocean-Setup-0.5.0.exe.01") { res.end(payload.subarray(0, 2000)); return; }
    if (req.url === "/ocean/Ocean-Setup-0.5.0.exe.02") { res.end(payload.subarray(2000)); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/ocean`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-upd-"));
  const app = (v) => ({ getVersion: () => v, getPath: () => temp });

  let ready = null;
  let u = createUpdater({ app: app("0.4.0"), baseUrl: base, platform: "win32", onReady: (s) => { ready = s; } });
  let st = await u.check({ manual: true });
  assert.equal(st.status, "ready", st.message);
  assert(ready && fs.readFileSync(st.file).equals(payload), "downloaded and verified");

  // Split into parts, joined in order.
  fs.rmSync(st.file, { force: true });
  latest = { ...latest, parts: [{ name: "Ocean-Setup-0.5.0.exe.01" }, { name: "Ocean-Setup-0.5.0.exe.02" }] };
  st = await createUpdater({ app: app("0.4.0"), baseUrl: base, platform: "win32", onReady: () => {} }).check({ manual: true });
  assert.equal(st.status, "ready", st.message);
  assert(fs.readFileSync(st.file).equals(payload), "parts joined correctly");
  latest = { ...latest, parts: undefined };

  u = createUpdater({ app: app("0.5.0"), baseUrl: base, platform: "win32", onReady: () => {} });
  st = await u.check({ manual: true });
  assert.equal(st.status, "current");

  latest = { ...latest, sha512: "0".repeat(128) };
  fs.rmSync(path.join(temp, "Ocean-Setup-0.5.0.exe"), { force: true });
  u = createUpdater({ app: app("0.4.0"), baseUrl: base, platform: "win32", onReady: () => {} });
  st = await u.check({ manual: true });
  assert.equal(st.status, "error");
  assert(/checksum/.test(st.message) && !fs.existsSync(path.join(temp, "Ocean-Setup-0.5.0.exe")), "bad file thrown away");

  latest = { ...latest, sha512: good, file: "../evil.exe" };
  st = await createUpdater({ app: app("0.4.0"), baseUrl: base, platform: "win32", onReady: () => {} }).check({ manual: true });
  assert.equal(st.status, "error");

  st = await createUpdater({ app: app("0.4.0"), baseUrl: "http://example.com/ocean", platform: "win32", onReady: () => {} }).check({ manual: true });
  assert.equal(st.status, "off", "plain http refused");

  server.close();
  console.log("All updater tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
