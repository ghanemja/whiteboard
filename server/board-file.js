// The board saved in the repo it's about: whiteboard.zip at the repo's root (AGENT_BOARD_FILE names
// another file, or "off"). Commit it and whoever opens the repo next gets the board, its decisions
// and its history. Inside:
//
//   whiteboard.json          { version, latest, runs: [ids, oldest first], project, goal, savedAt }
//   decisions.md             the latest run's decision log, to read without the app
//   runs/<id>.jsonl          each run in the chain, as recordings/ keeps it (replay, Timeline, carry on)
//   runs/<id>.decisions.md   and its decision log
//
// The zip is plain deflate, written and read here (Node has no zip of its own).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const BOARD_FILE = "whiteboard.zip";
export const boardFile = (env = process.env) => {
  const v = String(env.AGENT_BOARD_FILE ?? "").trim();
  if (["off", "0", "false", "no"].includes(v.toLowerCase())) return null;
  return v ? path.basename(v) : BOARD_FILE;
};

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

// { name: string | Buffer } → a zip's bytes.
export function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const packed = deflateRawSync(data);
    const fname = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(0x00210000, 10); // 1980-01-01, so the bytes don't change with the clock
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(fname.length, 26);
    local.push(head, fname, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    head.copy(dir, 8, 6, 26); // flags … sizes, as in the local header
    dir.writeUInt16LE(fname.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, fname);
    offset += head.length + fname.length + packed.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// A zip's bytes → { name: Buffer }. Stored and deflated entries (what zip tools write by default).
export function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("a broken zip directory");
    const method = buf.readUInt16LE(at + 10), packed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (method === 0) out[name] = Buffer.from(data);
    else if (method === 8) out[name] = inflateRawSync(data);
    // other methods (a zip someone made by hand with bzip2, say): skipped
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

// The repo's saved board: { meta, runs: [{ id, jsonl, decisions }], decisions } or null.
export function readBoardFile(repo, name = boardFile()) {
  if (!name) return null;
  const file = path.join(repo, name);
  if (!existsSync(file)) return null;
  const files = unzip(readFileSync(file));
  const meta = JSON.parse(files["whiteboard.json"]?.toString("utf8") ?? "null");
  if (!meta?.runs?.length) throw new Error(`${name} has no runs in it`);
  const runs = meta.runs
    .filter((id) => /^[\w-]+$/.test(id) && files[`runs/${id}.jsonl`])
    .map((id) => ({ id, jsonl: files[`runs/${id}.jsonl`].toString("utf8"), decisions: files[`runs/${id}.decisions.md`]?.toString("utf8") ?? "" }));
  return { meta, runs, decisions: files["decisions.md"]?.toString("utf8") ?? "" };
}

// Write it: the runs in the chain (oldest first, each { id, jsonl, decisions }) and what the board
// is. Written next to the old one and renamed over it, so a reader never sees half a file.
export function writeBoardFile(repo, { runs, project = null, goal = null }, name = boardFile()) {
  if (!name || !runs.length) return null;
  const latest = runs.at(-1);
  const files = {
    "whiteboard.json": `${JSON.stringify({ version: 1, latest: latest.id, runs: runs.map((r) => r.id), project, goal, savedAt: new Date().toISOString() }, null, 2)}\n`,
    "decisions.md": latest.decisions ?? "",
  };
  for (const r of runs) {
    files[`runs/${r.id}.jsonl`] = r.jsonl;
    if (r.decisions) files[`runs/${r.id}.decisions.md`] = r.decisions;
  }
  const file = path.join(repo, name);
  writeFileSync(`${file}.tmp`, zip(files));
  renameSync(`${file}.tmp`, file);
  return file;
}
