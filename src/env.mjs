import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function computeRoot() {
  if (process.env.RYOKUYU_ROOT) return path.resolve(process.env.RYOKUYU_ROOT);
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    // バンドル実行時（SEA など）は実行ファイルのあるフォルダをルートにする
    return path.dirname(process.execPath);
  }
}

export const ROOT = computeRoot();

/** .env を process.env に読み込む（既存の環境変数は優先） */
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig() {
  const file = path.join(ROOT, "config.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function logLine(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  const dir = ensureDir(path.join(ROOT, "logs"));
  fs.appendFileSync(path.join(dir, "publish.log"), line + "\n", "utf8");
  console.log(line);
}
