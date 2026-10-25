// Creates (or resets) sandbox/linkshort: a tiny, real repo for the agent to work in.
// It has no dependencies, so `npm test` (node --test) runs without installing anything.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("sandbox/linkshort");
rmSync(root, { recursive: true, force: true });

const files = {
  "package.json": JSON.stringify(
    { name: "linkshort", version: "0.1.0", type: "module", private: true, scripts: { start: "node src/server.js", test: "node --test" } },
    null,
    2,
  ),
  "README.md": `# linkshort

A tiny URL shortener.

- \`POST /links\` with \`{"url": "https://example.com"}\` returns \`{"code": "b"}\`
- \`GET /:code\` redirects to the stored URL

Run it with \`npm start\` (port 3000). Test with \`npm test\`.
`,
  "src/codes.js": `const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Encodes a non-negative integer as a short base62 code.
export function encode(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a non-negative integer");
  let code = "";
  do {
    code = ALPHABET[n % 62] + code;
    n = Math.floor(n / 62);
  } while (n > 0);
  return code;
}
`,
  "src/store.js": `import { encode } from "./codes.js";

// In-memory link store. Codes come from a counter, so they're short and never collide.
export function createStore() {
  const links = new Map();
  let next = 1;
  return {
    create(url) {
      const code = encode(next++);
      links.set(code, { url, createdAt: Date.now() });
      return code;
    },
    get(code) {
      return links.get(code) ?? null;
    },
  };
}
`,
  "src/server.js": `import http from "node:http";
import { createStore } from "./store.js";

export function createServer(store = createStore()) {
  return http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/links") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let url;
      try {
        url = new URL(JSON.parse(body).url).toString();
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Send JSON with a valid url" }));
      }
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ code: store.create(url) }));
    }

    if (req.method === "GET") {
      const link = store.get(req.url.slice(1));
      if (link) {
        res.writeHead(302, { location: link.url });
        return res.end();
      }
    }

    res.writeHead(404);
    res.end("Not found");
  });
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  createServer().listen(3000, () => console.log("linkshort on http://localhost:3000"));
}
`,
  "test/codes.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "../src/codes.js";

test("encodes small numbers as single characters", () => {
  assert.equal(encode(0), "0");
  assert.equal(encode(61), "Z");
});

test("rolls over to two characters at 62", () => {
  assert.equal(encode(62), "10");
});
`,
  "test/server.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

async function withServer(fn) {
  const server = createServer().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(\`http://localhost:\${server.address().port}\`);
  } finally {
    server.close();
  }
}

test("shortens a link and redirects to it", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/links\`, { method: "POST", body: JSON.stringify({ url: "https://example.com/a" }) });
    assert.equal(res.status, 201);
    const { code } = await res.json();
    const hop = await fetch(\`\${base}/\${code}\`, { redirect: "manual" });
    assert.equal(hop.status, 302);
    assert.equal(hop.headers.get("location"), "https://example.com/a");
  }));

test("rejects an invalid url", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/links\`, { method: "POST", body: JSON.stringify({ url: "nope" }) });
    assert.equal(res.status, 400);
  }));
`,
};

for (const [file, content] of Object.entries(files)) {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=sandbox", "-c", "user.email=sandbox@localhost", ...args], { stdio: "ignore" });
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "linkshort: shorten and redirect");
console.log(`Sandbox repo ready: ${root}`);
