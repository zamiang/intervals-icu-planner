// Sync the Intervals.icu custom items defined in src/customItems.ts (fitness
// charts + computed activity fields) to the account. Items are matched by
// (type, name): missing ones are created, drifted ones are updated in place,
// matching ones are left alone. Items on the account that aren't defined in
// customItems.ts are never touched.
//
//   npm run sync-custom-items              # dry run (default)
//   npm run sync-custom-items -- --apply   # actually create/update
//
// Idempotent: a second --apply run reports everything unchanged. Note the
// computed activity fields only populate on activities analyzed after the
// fields exist — re-analyze older activities from the UI (Activities → select
// → ANALYZE) to backfill.
import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
import { CUSTOM_ITEM_DEFS, planSync } from "../src/customItems.js";
import { IntervalsClient } from "../src/intervals.js";

const apply = process.argv.slice(2).includes("--apply");

const intervalsKey = process.env.INTERVALS_API_KEY;
if (!intervalsKey) {
  console.error("Missing INTERVALS_API_KEY in .env (Intervals.icu → Settings → API).");
  process.exit(1);
}

const client = new IntervalsClient(intervalsKey);
const existing = await client.getCustomItems();
const plan = planSync(CUSTOM_ITEM_DEFS, existing);

console.log(
  `${apply ? "APPLYING" : "DRY RUN"} — ${CUSTOM_ITEM_DEFS.length} defined item(s), ` +
    `${existing.length} on the account\n`,
);

for (const { def, id } of plan.unchanged) {
  console.log(`= ${def.type}  ${def.name}  (#${id}, unchanged)`);
}
for (const { def, id } of plan.update) {
  console.log(`~ ${def.type}  ${def.name}  (#${id}, will update)`);
}
for (const def of plan.create) {
  console.log(`+ ${def.type}  ${def.name}  (will create)`);
}

if (apply) {
  for (const { id, def } of plan.update) {
    await client.updateCustomItem(id, def);
  }
  for (const def of plan.create) {
    await client.createCustomItem(def);
  }
}

console.log(
  `\n${plan.unchanged.length} unchanged, ${plan.update.length} updated, ` +
    `${plan.create.length} created` +
    (apply ? "." : ". Re-run with --apply to write."),
);
