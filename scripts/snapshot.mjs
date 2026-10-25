import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "../src/env.mjs";
import { createStore } from "../src/firestore.mjs";

const store = createStore(loadConfig());
const settings = await store.getDoc("site_settings/main");
const records = await store.query("activity_records", { limit: 200 });

const dir = path.join(ROOT, "backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(dir, `site_settings_${stamp}.json`);
fs.writeFileSync(
  file,
  JSON.stringify(
    { savedAt: new Date().toISOString(), settings, recordIds: records.map((r) => r.id) },
    null,
    2
  ),
  "utf8"
);

console.log(`BACKUP=${file}`);
console.log(`RECORDS=${records.map((r) => r.id).join(",")}`);
console.log("SETTINGS=" + JSON.stringify({
  modal_message_title: settings?.modal_message_title,
  modal_message_content: settings?.modal_message_content,
  modal_message_button_text: settings?.modal_message_button_text,
  modal_message_button_url: settings?.modal_message_button_url,
}));
