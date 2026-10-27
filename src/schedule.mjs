import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, loadConfig } from "./env.mjs";
import { createStore } from "./firestore.mjs";
import { validateDraft, publishDraft } from "./publish.mjs";

/**
 * 予約投稿キュー
 *
 * schedule.json に「いつ・どの下書きを公開するか」を保存し、
 * 期限が来たものを publishDraft() で公開する。
 *
 * - 日時はすべて日本時間（Asia/Tokyo）で扱う
 * - 複数プロセス（Webサーバーとタスクスケジューラ）が同時に動いても
 *   ロックファイルで二重公開を防ぐ
 * - PCがスリープ/電源OFFで時刻を過ぎた場合は、次に動いたときに公開する
 */

const JST_OFFSET = "+09:00";
const STALE_LOCK_MS = 10 * 60 * 1000;
const STALE_RUNNING_MS = 15 * 60 * 1000;

export function schedulePath() {
  return process.env.RYOKUYU_SCHEDULE_FILE || path.join(ROOT, "schedule.json");
}

export function scheduleLog(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  const dir = ensureDir(path.join(ROOT, "logs"));
  fs.appendFileSync(path.join(dir, "schedule.log"), line + "\n", "utf8");
}

function toPosix(p) {
  return String(p).split(path.sep).join("/");
}

function readJsonFile(abs) {
  let text = fs.readFileSync(abs, "utf8");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

export function loadSchedule() {
  const file = schedulePath();
  if (!fs.existsSync(file)) return [];
  try {
    const data = readJsonFile(file);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const backup = `${file}.broken-${Date.now()}`;
    try {
      fs.copyFileSync(file, backup);
    } catch {
      /* バックアップできなくても続行 */
    }
    scheduleLog("SCHEDULE_READ_FAILED", err.message, `backup=${backup}`);
    return [];
  }
}

function saveSchedule(jobs) {
  const file = schedulePath();
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 日時文字列を Date に変換する。
 * タイムゾーン指定がないものは日本時間として解釈する。
 *
 * 例: "2026-11-05 08:00" / "2026-11-05T08:00" / "2026/11/05 8:00"
 *     "2026-11-05T08:00:00+09:00" / "2026-11-05T00:00:00Z"
 *     "+30m" / "+2h" / "+1d" / "now"
 */
export function parseWhen(input, now = new Date()) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("日時を指定してください（例: 2026-11-05 08:00）");

  if (raw.toLowerCase() === "now") return new Date(now.getTime());

  const rel = raw.match(/^\+(\d+)\s*(m|min|分|h|hour|時間|d|day|日)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("m") && !unit.startsWith("min") ? n * 60 * 1000
      : unit === "min" || unit === "分" ? n * 60 * 1000
      : unit === "h" || unit === "hour" || unit === "時間" ? n * 60 * 60 * 1000
      : n * 24 * 60 * 60 * 1000;
    if (!n) throw new Error("相対指定は 1 以上で指定してください（例: +30m）");
    return new Date(now.getTime() + ms);
  }

  // タイムゾーン付き ISO
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error(`日時を解釈できません: ${raw}`);
    return d;
  }

  // 日付 + 時刻（タイムゾーンなし = 日本時間）
  const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if (m) {
    const [, y, mo, da, hh = "0", mi = "0", ss = "0", ms = "0"] = m;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padEnd(3, "0")}${JST_OFFSET}`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new Error(`日時を解釈できません: ${raw}`);
    return d;
  }

  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  throw new Error(`日時を解釈できません: ${raw}（例: 2026-11-05 08:00）`);
}

/** 日本時間の "2026-11-05 08:00" 形式にする */
export function formatJst(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date ?? "");
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return parts;
}

export function statusLabel(status) {
  return {
    pending: "予約済",
    running: "実行中",
    done: "公開済",
    failed: "失敗",
    cancelled: "キャンセル",
  }[status] || status;
}

function resolveJobFile(job) {
  let file = String(job.file || "").trim();
  if (!file) throw new Error("予約に対象ファイルがありません");
  if (!path.isAbsolute(file)) {
    // 旧形式（ファイル名だけ）への互換
    if (!file.startsWith("drafts/") && !file.startsWith("inbox/") && !file.includes("/") && !file.includes("\\")) {
      file = path.join("drafts", file);
    }
    file = path.join(ROOT, file);
  }
  return file;
}

/** 下書きファイルを検証して、予約ジョブを作る */
export function addJob({ file, publishAt, notice, force = false, type = "activity", ...extra } = {}) {
  if (!file) throw new Error("下書きファイルを指定してください");
  if (!publishAt) throw new Error("公開日時（publishAt）を指定してください");

  const when = publishAt instanceof Date ? publishAt : parseWhen(publishAt);
  if (Number.isNaN(when.getTime())) throw new Error("公開日時を解釈できません");

  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) throw new Error(`下書きが見つかりません: ${file}`);
  if (!fs.statSync(abs).isFile()) throw new Error(`下書きがファイルではありません: ${file}`);

  const rel = toPosix(path.relative(ROOT, abs));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("下書きはこのツールのフォルダ内にあるファイルを指定してください");
  }

  let job;
  if (type === "activity") {
    const draft = readJsonFile(abs);
    validateDraft(draft);
    job = {
      id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "activity",
      status: "pending",
      file: rel,
      title: draft.title,
      draftId: draft.id,
      publishAt: when.toISOString(),
      createdAt: new Date().toISOString(),
      notice,
      force: Boolean(force),
      ...extra,
    };
  } else {
    job = {
      id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      status: "pending",
      publishAt: when.toISOString(),
      createdAt: new Date().toISOString(),
      ...extra,
    };
  }

  return withScheduleLock(() => {
    const jobs = loadSchedule();

    if (type === "activity") {
      const duplicate = jobs.find((j) => j.status === "pending" && toPosix(j.file || "") === rel);
      if (duplicate) {
        throw new Error(
          `この下書きはすでに予約済みです: ${formatJst(duplicate.publishAt)}（${duplicate.id}）\n` +
            "変更する場合は、いったん予約を取り消してください。"
        );
      }
    }

    jobs.push(job);
    saveSchedule(jobs);
    scheduleLog("SCHEDULED", job.id, job.publishAt, job.file || job.type);
    return job;
  });
}

export function cancelJob(id) {
  return withScheduleLock(() => {
    const jobs = loadSchedule();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`予約が見つかりません: ${id}`);
    if (job.status === "done") throw new Error("公開済みの予約は取り消せません");
    if (job.status === "running") throw new Error("実行中の予約は取り消せません。少し待ってから確認してください");
    if (job.status === "cancelled") return job;
    job.status = "cancelled";
    job.cancelledAt = new Date().toISOString();
    saveSchedule(jobs);
    scheduleLog("CANCELLED", job.id);
    return job;
  });
}

function acquireLock() {
  const lock = `${schedulePath()}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* すでに消えていればOK */
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* 競合したら次の試行へ */
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

function withScheduleLock(fn) {
  const release = acquireLock();
  if (!release) {
    throw new Error("予約の処理中です。少し待ってからもう一度お試しください。");
  }
  try {
    return fn();
  } finally {
    release();
  }
}

async function executeJob(job, { dryRun, config, store }) {
  if (!job.type || job.type === "activity") {
    const abs = resolveJobFile(job);
    if (!fs.existsSync(abs)) throw new Error(`下書きが見つかりません: ${job.file}`);
    const draft = readJsonFile(abs);
    validateDraft(draft);

    if (dryRun) {
      return { id: draft.id, title: draft.title, dryRun: true, url: `${config.site.baseUrl}/activity/${draft.id}` };
    }

    const existing = await store.getDoc(`activity_records/${draft.id}`);
    if (existing) {
      return {
        id: draft.id,
        title: draft.title,
        skipped: true,
        reason: "すでに公開済みのためスキップしました",
        url: `${config.site.baseUrl}/activity/${draft.id}`,
      };
    }

    const result = await publishDraft(draft, config, {
      dryRun: false,
      notice: job.notice,
      force: Boolean(job.force),
    });

    return {
      id: result.document.id,
      title: result.document.title,
      url: `${config.site.baseUrl}/activity/${result.document.id}`,
      notice: Boolean(result.notice),
      noticeError: result.noticeError,
    };
  }

  if (job.type === "promise-update") {
    await store.updateDoc(`promises/${job.promiseId}`, job.patch || {});
    return { promiseId: job.promiseId, patch: job.patch };
  }
  if (job.type === "promise-add") {
    const id = job.promiseId || `promise-${Date.now()}`;
    await store.createDoc(`promises/${id}`, { id, ...(job.data || {}) });
    return { id };
  }
  if (job.type === "suggest-reply") {
    await store.updateDoc(`suggestions/${job.suggestionId}`, {
      reply: job.reply,
      status: job.status2 || "対応済",
    });
    return { suggestionId: job.suggestionId };
  }
  if (job.type === "form-create") {
    const id = job.formId || `form-${Date.now()}`;
    await store.createDoc(`forms/${id}`, { id, ...(job.data || {}) });
    return { id };
  }
  if (job.type === "form-close") {
    await store.updateDoc(`forms/${job.formId}`, { is_open: false });
    return { formId: job.formId };
  }

  throw new Error(`不明な予約タイプです: ${job.type}`);
}

/**
 * 期限が来た予約を処理する。
 * ロックが取れない場合（別プロセスが実行中）は { busy: true } を返す。
 */
export async function runDue({ dryRun = false, now = new Date() } = {}) {
  const release = acquireLock();
  if (!release) return { busy: true, processed: [], pending: 0 };

  try {
    const config = loadConfig();
    const store = createStore(config);
    const jobs = loadSchedule();
    let changed = false;
    const results = [];

    // 前回の実行が強制終了して "running" のまま残ったものを戻す
    for (const job of jobs) {
      if (job.status !== "running") continue;
      const started = new Date(job.startedAt || job.createdAt || 0).getTime();
      if (Date.now() - started > STALE_RUNNING_MS) {
        job.status = "pending";
        job.error = "前回の実行が中断されたため再試行します";
        changed = true;
      }
    }

    const due = jobs
      .filter((j) => j.status === "pending" && new Date(j.publishAt) <= now)
      .sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));

    for (const job of due) {
      if (!dryRun) {
        job.status = "running";
        job.startedAt = new Date().toISOString();
        delete job.error;
        saveSchedule(jobs);
      }

      try {
        const result = await executeJob(job, { dryRun, config, store });
        if (dryRun) {
          results.push({ job, result, ok: true });
          continue;
        }
        job.status = "done";
        job.publishedAt = new Date().toISOString();
        job.result = result;
        delete job.error;
        if (result?.noticeError) job.error = `お知らせ更新に失敗: ${result.noticeError}`;
        results.push({ job, result, ok: true });
        scheduleLog("PUBLISHED", job.id, result?.id || "", result?.skipped ? "skipped" : "ok");
      } catch (err) {
        if (!dryRun) {
          job.status = "failed";
          job.error = err.message;
          job.finishedAt = new Date().toISOString();
        }
        results.push({ job, error: err.message, ok: false });
        scheduleLog("FAILED", job.id, err.message.replace(/\s+/g, " ").slice(0, 300));
      }

      if (!dryRun) saveSchedule(jobs);
    }

    if (changed && !dryRun) saveSchedule(jobs);

    return {
      busy: false,
      dryRun,
      processed: results,
      pending: jobs.filter((j) => j.status === "pending").length,
    };
  } finally {
    release();
  }
}
