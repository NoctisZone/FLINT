/**
 * Setting up a new agent on the running gateway as one job with named
 * steps. The step functions are handed in (onboard.mjs has the real ones);
 * the job records what each did, writes itself through `save` after every
 * change, and a retry goes on from the step that failed. `data` is what the
 * steps remember between tries (the deposit's hash, coins minted so far);
 * the view the owner sees carries the steps and their details only.
 */
export const STEPS = ["wallet", "mint", "strike", "open", "register", "quote"];

/**
 * @param {object} o
 * @param {Record<string, (ctx, step) => Promise<string|void>>} o.steps   one per STEPS entry
 * @param {object} [o.saved]                                                 a job read back from disk
 * @param {(job) => void} [o.save]
 * @param {(job) => void} [o.onChange]                                       after every change, for the feed
 */
export function onboardJob({ agentId, index, owner, mind, kind = "onboard", order = STEPS, spec = null, steps, saved = null, save = () => {}, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const iso = () => new Date(now()).toISOString();
  // `spec` is what was ordered (pay, deposit, fee, key), kept with the job so a restart knows it too
  const job = saved ?? { kind, agentId, index, owner, mind, spec, status: "pending", startedAt: iso(), updatedAt: iso(), error: null, steps: order.map((step) => ({ step, status: "pending", detail: null, at: null })), data: {} };
  // what a step waits for from the owner (a signed transaction): delivered through the API, one slot per kind
  const waiting = new Map(); // what → { resolve, timer }
  const delivered = new Map(); // what → value, when it came before the step asked
  // a job read back after a restart was running when the process ended: it goes on from that step on retry
  if (saved) { for (const s of job.steps) if (s.status === "running") { s.status = "failed"; s.detail = "the gateway restarted during this step"; } if (job.status === "running") { job.status = "failed"; job.error = "the gateway restarted"; } }
  const touch = () => { job.updatedAt = iso(); save(job); onChange(job); };
  const current = () => job.steps.find((s) => s.status !== "done") ?? null;
  const ctx = {
    data: job.data,
    set(key, value) { job.data[key] = value; touch(); },
    note(detail) { const s = current(); if (s) { s.detail = detail; touch(); } },
    /** Resolves with what the owner delivers under `what`, or null when `timeoutMs` pass first. */
    waitFor(what, timeoutMs) {
      if (delivered.has(what)) { const v = delivered.get(what); delivered.delete(what); return Promise.resolve(v); }
      return new Promise((resolve) => {
        const timer = setTimer(() => { waiting.delete(what); touch(); resolve(null); }, timeoutMs);
        waiting.set(what, { resolve, timer });
        touch();
      });
    },
  };
  let running = null;

  function run() {
    if (running) return running;
    if (job.status === "done") return Promise.resolve(job);
    if (job.status === "cancelled") throw Object.assign(new Error("the order was cancelled"), { status: 409 });
    running = (async () => {
      job.status = "running"; job.error = null; touch();
      for (const s of job.steps) {
        if (s.status === "done") continue;
        s.status = "running"; s.at = iso(); s.detail = null; touch();
        try {
          const detail = await steps[s.step](ctx, s);
          if (cancelled) throw new Error("the order was cancelled");
          s.status = "done"; s.at = iso(); if (detail) s.detail = detail; touch();
        } catch (err) {
          s.status = "failed"; s.at = iso(); s.detail = cancelled ? "cancelled by the owner" : String(err?.message ?? err).slice(0, 240);
          job.status = cancelled ? "cancelled" : "failed"; job.error = cancelled ? "cancelled by the owner" : `${s.step}: ${s.detail}`; touch();
          return job;
        }
      }
      job.status = "done"; touch();
      return job;
    })().finally(() => { running = null; });
    return running;
  }
  let cancelled = false;

  return {
    agentId: job.agentId,
    get job() { return job; },
    ctx,
    /** Run from the first step not done; resolves with the job when it stops, done or failed. */
    run,
    /** After a failure: the same, from the failed step. */
    retry() {
      if (job.status !== "failed") throw Object.assign(new Error(`job is ${job.status}, nothing to retry`), { status: 409 });
      return run();
    },
    get running() { return running !== null; },
    /** The owner takes the order back: a step waiting on them ends now, a failed job is closed; resolves once the job stands still. */
    async cancel() {
      if (job.status === "done" || job.status === "cancelled") throw Object.assign(new Error(`job is ${job.status}, nothing to cancel`), { status: 409 });
      cancelled = true;
      for (const [what, w] of waiting) { waiting.delete(what); clearTimer(w.timer); w.resolve(null); }
      if (running) await running;
      else { job.status = "cancelled"; job.error = "cancelled by the owner"; touch(); }
      return job;
    },
    /** Something the owner hands in for a waiting step; false when no step waits for it (kept for the next one that asks). */
    deliver(what, value) {
      const w = waiting.get(what);
      if (!w) { delivered.set(what, value); return false; }
      waiting.delete(what); clearTimer(w.timer); w.resolve(value); return true;
    },
    get waitingFor() { return [...waiting.keys()]; },
    /** What the owner sees: the steps, the agent's Cardano address and what to send there, never the rest of `data`. The tools key is in the first view that carries it, then gone from the job. */
    view() {
      const { data, ...rest } = job;
      const toolsKey = data.toolsKey ?? null;
      if (toolsKey) { delete data.toolsKey; save(job); }
      return { ...rest, current: current()?.step ?? null, waitingFor: [...waiting.keys()], steps: job.steps.map((s) => ({ ...s })), cardano: data.cardano ?? null, fundAda: data.fundAda ?? null, toolsKey, ...(data.pub ?? {}) };
    },
  };
}
