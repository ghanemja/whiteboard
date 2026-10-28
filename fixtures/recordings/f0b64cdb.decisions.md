# Decisions: linkshort aliases

- **Task:** Support custom aliases like /launch
- **Repo:** `/home/you/whiteboard/sandbox/linkshort`
- **Started:** 2026-10-25T01:59:01.639Z · claude-opus-5-5 (effort low)
- **Agent session:** `5b53d01b-66d5-4eca-8b95-0640c9ed7c91`
- **Recording:** `recordings/f0b64cdb.jsonl` (replay or reopen it in Agent Whiteboard)

## Current plan

### Goal

POST /links accepts an optional alias so /launch redirects to the given URL.

### Architecture

| Component | Kind | Libraries | Interface | Files | Status |
|---|---|---|---|---|---|
| Client | user |  |  |  | live |
| HTTP server | service | node:http | `POST /links {url, alias?}`, `GET /:code` | `src/server.js` | live |
| Link store | data | Map | `create(url, alias?)`, `get(code)` | `src/store.js`, `src/codes.js` | live |
| Tests | test | node:test |  | `test/` | live |

### Connections

- Client → HTTP server · HTTP · `POST /links {url, alias}`
- HTTP server → Link store · call · `store.create(url, alias)`
- Tests → HTTP server · HTTP

### Decisions

#### D1 · Alias format (changed)

- **Chose:** /^[A-Za-z0-9._-]{1,64}$/ and not all dots, else 400
- **Before:** ~~/^[A-Za-z0-9_-]{1,64}$/, else 400~~
- **Over:** No dots; Any string, URL-encoded; Lowercase-only
- **Why:** Dots let versioned aliases like v1.2 work. Aliases made only of dots ('.', '..') are rejected because clients normalize them as path segments.
- **Evidence:** src/server.js routes GET by req.url.slice(1)
- **Affects:** HTTP server

#### D2 · Alias already taken (accepted)

- **Chose:** 409 Conflict
- **Over:** Overwrite; Append suffix
- **Why:** Silently changing someone's link is worse than telling the client.
- **Affects:** HTTP server, Link store
- **Builds on:** D1

#### D3 · Counter vs alias collision (accepted)

- **Chose:** Generated codes skip any code already in the Map
- **Over:** Prefix aliases; Forbid base62-looking aliases
- **Why:** Alias 'b' would otherwise be clobbered by counter code 11; skipping costs a cheap has() loop.
- **Evidence:** src/store.js: encode(next++) with no existence check
- **Affects:** Link store
- **Builds on:** D2

## Timeline

### 00:00 · You: Started a task

> Support custom aliases like /launch

### 00:18 · Agent: Proposed a plan

- Components: Client (user), HTTP server (service, node:http), Link store (data, Map), Tests (test, node:test)
- D1 Alias format: **/^[A-Za-z0-9_-]{1,64}$/, else 400** over Any string, URL-encoded, Lowercase-only
- D2 Alias already taken: **409 Conflict** over Overwrite, Append suffix
- D3 Counter vs alias collision: **Generated codes skip any code already in the Map** over Prefix aliases, Forbid base62-looking aliases
- Steps: Read server/store; Decide alias rules

> The plan for custom aliases is on the board. It needs your approval before I change any code.

### 00:58 · You: Asked for changes to the plan

> About D1 (/^[A-Za-z0-9_-]{1,64}$/, else 400 over Any string, URL-encoded, Lowercase-only): allow dots too, so versioned aliases like /v1.2 work

### 01:01 · Agent: Changed D1: Alias format

- Was: /^[A-Za-z0-9_-]{1,64}$/, else 400
- Now: **/^[A-Za-z0-9._-]{1,64}$/ and not all dots, else 400**

> Dots let versioned aliases like v1.2 work. Aliases made only of dots ('.', '..') are rejected because clients normalize them as path segments.

### 01:07 · Agent: Proposed a plan

- Components: Client (user), HTTP server (service, node:http), Link store (data, Map), Tests (test, node:test)
- D1 Alias format: **/^[A-Za-z0-9._-]{1,64}$/ and not all dots, else 400** over No dots, Any string, URL-encoded, Lowercase-only
- D2 Alias already taken: **409 Conflict** over Overwrite, Append suffix
- D3 Counter vs alias collision: **Generated codes skip any code already in the Map** over Prefix aliases, Forbid base62-looking aliases
- Steps: Read server/store; Decide alias rules

### 01:36 · You: Approved the plan

### 03:57 · You: Allowed a command

- Implement aliases, add tests, run tests

```sh
python3 - <<'EOF'
p='src/store.js'; s=open(p).read()
s=s.replace('''    create(url) {
      const code = encode(next++);''','''    // Returns the code, or null if the requested alias is taken.
    create(url, alias) {
      if (alias !== undefined && links.has(alias)) return null;
      let code = alias;
      // Generated codes skip anything already claimed by an alias.
      while (code === undefined || (alias === undefined && links.has(code))) code = encode(next++);''')
open(p,'w').write(s)
p='src/server.js'; s=open(p).read()
s=s.replace('''import { createStore } from "./store.js";
''','''import { createStore } from "./store.js";

const ALIAS = /^(?!\\.+$)[A-Za-z0-9._-]{1,64}$/;
''')
s=s.replace('''      let url;
      try {
        url = new URL(JSON.parse(body).url).toString();''','''      let url, alias;
      try {
        ({ url, alias } = JSON.parse(body));
        url = new URL(url).toString();''')
s=s.replace('''      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ code: store.create(url) }));''','''      if (alias !== undefined && (typeof alias !== "string" || !ALIAS.test(alias))) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "alias must be 1-64 of A-Z a-z 0-9 . _ - and not only dots" }));
      }
      const code = store.create(url, alias);
      if (code === null) {
        res.writeHead(409, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "alias already taken" }));
      }
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ code }));''')
open(p,'w').write(s)
p='README.md'; s=open(p).read()
s=s.replace('''- `GET''','''- Add `"alias": "launch"` to pick the code yourself (`A-Z a-z 0-9 . _ -`, up to 64 chars, not only dots). Invalid → 400, taken → 409
- `GET''')
open(p,'w').write(s)
EOF
cat >> test/server.test.js <<'EOF'

const post = (base, body) => fetch(`${base}/links`, { method: "POST", body: JSON.stringify(body) });

test("custom aliases redirect, including dotted ones", () =>
  withServer(async (base) => {
    for (const alias of ["launch", "v1.2"]) {
      const res = await post(base, { url: "https://example.com/x", alias });
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { code: alias });
      const hop = await fetch(`${base}/${alias}`, { redirect: "manual" });
      assert.equal(hop.headers.get("location"), "https://example.com/x");
    }
  }));

test("rejects invalid aliases", () =>
  withServer(async (base) => {
    for (const alias of ["..", ".", "a/b", "", "x".repeat(65), 5]) {
      assert.equal((await post(base, { url: "https://example.com", alias })).status, 400);
    }
  }));

test("rejects a taken alias", () =>
  withServer(async (base) => {
    await post(base, { url: "https://example.com/1", alias: "launch" });
    assert.equal((await post(base, { url: "https://example.com/2", alias: "launch" })).status, 409);
  }));

test("generated codes skip aliased ones", () =>
  withServer(async (base) => {
    await post(base, { url: "https://example.com/alias", alias: "1" });
    const { code } = await (await post(base, { url: "https://example.com/gen" })).json();
    assert.equal(code, "2");
    const hop = await fetch(`${base}/1`, { redirect: "manual" });
    assert.equal(hop.headers.get("location"), "https://example.com/alias");
  }));
EOF
npm test 2>&1 | tail -12
```

### 04:06 · Agent: Finished

- Board: Client: live, HTTP server: live, Link store: live, Tests: live
- 13 turns, $0.20

> You can now choose your own short code: `POST /links` accepts an optional `alias`, so `{"url": "...", "alias": "launch"}` makes `/launch` redirect there. All 8 tests pass (`npm test`), including the 4 new ones.
> 
> - **Allowed aliases:** letters, digits, `.`, `_` and `-`, up to 64 characters, so `v1.2` works. An alias made only of dots is rejected. A bad alias gets a 400 and one that's already in use gets a 409.
> - **One behaviour change:** automatic codes now skip any code an alias already uses. For example, if someone claims the alias `1`, the next automatic code is `2`, so the alias isn't overwritten.
> 
> The changes are in `src/server.js` and `src/store.js`, and the README now documents aliases. To try it, run `npm start`, then `curl -XPOST localhost:3000/links -d '{"url":"https://example.com","alias":"launch"}'`.

