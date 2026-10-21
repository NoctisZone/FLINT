/**
 * What the market's key has left today: sponsored jobs counted here per UTC
 * day against the key's daily allowance. Every trader hands its jobs in with
 * the same key, so they share one count. A refusal for a spent budget sets
 * the day's count to the allowance, so the server's word wins over the count.
 */
import fs from "node:fs";
import path from "node:path";

export const JOBS_FILE = path.join("data", "jobs.json");
// sponsored jobs a day on a key of the gateway
export const JOBS_PER_DAY = 1000;

const today = (now) => new Date(now()).toISOString().slice(0, 10);

/**
 * @param {object} [o]
 * @param {number} [o.jobsPerDay]   sponsored jobs the key may hand in a day
 */
export function keyBudget({ jobsPerDay = JOBS_PER_DAY, file = JOBS_FILE, now = () => Date.now() } = {}) {
  const read = () => {
    try {
      const b = JSON.parse(fs.readFileSync(file, "utf8"));
      return b.day === today(now) && typeof b.used === "number" ? b : { day: today(now), used: 0 };
    } catch { return { day: today(now), used: 0 }; }
  };
  const write = (b) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(b));
  };
  return {
    /** The jobs left today, the same for every trader. */
    left: () => ({ jobs: jobsPerDay - read().used }),
    spend(name, n = 1) {
      const b = read();
      b.used += n;
      write(b);
    },
    exhausted() {
      const b = read();
      b.used = Math.max(b.used, jobsPerDay);
      write(b);
    },
  };
}
