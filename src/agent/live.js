// Browser side of the agent runs API (server/runs.js): start a Claude Agent SDK run
// in a repo, follow its event stream, and answer it (plan approval, permissions, chat).

export async function getAgentStatus() {
  try {
    const res = await fetch("/api/runs/status");
    return res.ok ? await res.json() : { live: false };
  } catch {
    return { live: false };
  }
}

async function post(url, body) {
  // keepalive: a stop sent while the tab closes or reloads still reaches the server.
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const startRun = ({ repo, brief }) => post("/api/runs", { repo, brief });

// ---- saved runs ----
export async function listRecordings() {
  try {
    const res = await fetch("/api/runs/recordings");
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function loadRecording(id) {
  const res = await fetch(`/api/runs/recordings/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Couldn't load recording ${id} (${res.status})`);
  return (await res.text())
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // a line cut off by a crash
      }
    });
}

export const decisionsUrl = (id) => `/api/runs/recordings/${encodeURIComponent(id)}/decisions`;
export const controlRun = (id, body) => post(`/api/runs/${id}/control`, body);

// Calls onEvent for every event of the run, from the beginning, until the run closes or signal aborts.
export async function followRun(id, { onEvent, signal }) {
  const res = await fetch(`/api/runs/${id}/events`, { signal });
  if (!res.ok) throw new Error(`Couldn't follow the run (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}
