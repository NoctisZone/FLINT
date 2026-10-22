/**
 * The decision log: one JSON line per entry, each carrying the hash of the
 * line before it, so a line cannot be changed or dropped without breaking
 * the chain. `verifyLog` walks a file and reports the first broken link.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GENESIS = "0".repeat(64);
const hashOf = (entry) => crypto.createHash("sha256").update(JSON.stringify(entry), "utf8").digest("hex");

/** Append-only log in `file`; `now` for tests. */
export function decisionLog(file, { now = () => new Date().toISOString() } = {}) {
  let prev = GENESIS;
  let seq = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line);
      prev = e.hash;
      seq = e.seq;
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  return {
    /** Writes the entry and returns it with seq, ts, prev and hash. */
    append(entry) {
      // an entry's own `hash` would be overwritten by the chain's and the line could never verify again
      if ("hash" in entry) throw new Error(`log entry ${entry.kind ?? "?"} carries a hash field; name it mandateHash or payloadHash`);
      const body = { ...entry, seq: seq + 1, ts: now(), prev };
      const full = { ...body, hash: hashOf(body) };
      fs.appendFileSync(file, JSON.stringify(full) + "\n");
      prev = full.hash;
      seq = full.seq;
      return full;
    },
    get head() { return { seq, hash: prev }; },
  };
}

/**
 * { ok, entries, brokenAt } for a log file. With `fromSeq` the chain is
 * checked from that entry on, anchored on its own `prev`: what one run
 * wrote stays verifiable when an older part of the file is broken.
 */
export function verifyLog(file, { fromSeq = 1 } = {}) {
  let prev = GENESIS;
  let expect = fromSeq;
  let checked = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const { hash, ...body } = JSON.parse(line);
    if (body.seq < fromSeq) continue;
    if (body.seq === fromSeq && fromSeq > 1 && checked === 0) prev = body.prev;
    checked += 1;
    if (body.prev !== prev || hashOf(body) !== hash || body.seq !== expect) return { ok: false, entries: checked, brokenAt: body.seq };
    prev = hash;
    expect += 1;
  }
  return { ok: true, entries: checked, brokenAt: null };
}
