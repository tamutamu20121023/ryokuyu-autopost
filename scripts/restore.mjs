import fs from "node:fs";
import { loadConfig } from "../src/env.mjs";
import { createStore } from "../src/firestore.mjs";

const file = process.argv[2];
if (!file) {
  console.error("使い方: node scripts/restore.mjs backups/site_settings_xxx.json");
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(file, "utf8"));
const store = createStore(loadConfig());
const s = backup.settings || {};

const fields = {
  modal_message_title: s.modal_message_title ?? "",
  modal_message_content: s.modal_message_content ?? "",
  modal_message_button_text: s.modal_message_button_text ?? "",
  modal_message_button_url: s.modal_message_button_url ?? "",
};

await store.updateDoc("site_settings/main", fields);
console.log("RESTORED=" + JSON.stringify(fields));
