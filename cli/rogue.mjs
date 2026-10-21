#!/usr/bin/env node
/**
 * The rogue agent against its mandate, at the live Strike mark (or 80000
 * offline): every attempt and the rule that refused it.
 *
 *   npm run rogue [-- --offline]
 */
import { strikeClient } from "../gateway/strike.mjs";
import { profiles } from "../agents/profiles.mjs";
import { runRogue } from "../agents/rogue.mjs";

const offline = process.argv.includes("--offline");
const mark = offline ? 80_000 : Number((await strikeClient({ baseUrl: process.env.STRIKE_API_URL || undefined }).premiumIndex("BTC-USD")).markPrice);
const rogue = profiles({ owner: "addr_test1…owner", expiry: new Date(Date.now() + 86_400_000).toISOString() }).rogue;
const { results, rules, allRefused } = runRogue(rogue, mark);

console.log(`rogue agent "${rogue.agentId}" at mark ${mark}: ${results.length} attempts, ${results.filter((r) => r.refused).length} refused, ${rules.length} distinct rules\n`);
const w = Math.max(...results.map((r) => r.label.length));
for (const r of results) {
  const x = r.refused;
  console.log(`${r.label.padEnd(w)}  ${x ? `refused  ${x.rule}  limit ${x.limit}  attempted ${x.attempted}` : "PASSED"}`);
}
if (!allRefused) process.exit(1);
