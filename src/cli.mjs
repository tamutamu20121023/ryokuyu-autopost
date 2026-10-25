#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ROOT, loadEnv, loadConfig, ensureDir, logLine } from "./env.mjs";
import { createStore } from "./firestore.mjs";
import { readNote, listNotes } from "./notes.mjs";
import { generateArticle, buildCopyPrompt, resolveProvider, extractJson } from "./ai.mjs";
import { validateDraft, publishDraft, writePreview } from "./publish.mjs";
import { CATEGORIES, normalizeAiResult } from "./prompt.mjs";
import { htmlToText } from "./html.mjs";

loadEnv();
const config = loadConfig();

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline !== undefined) {
        opts[key] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        opts[key] = argv[++i];
      } else {
        opts[key] = true;
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function todayJst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function printHelp() {
  console.log(`緑友役員会 自動投稿ツール

使い方:
  node src/cli.mjs new                          対話形式で1件つくる（おすすめ）
  node src/cli.mjs status                         状態確認（AI設定・下書き・最近の投稿）
  node src/cli.mjs doctor                         接続確認（読み取り・書き込み）
  node src/cli.mjs list [--limit 10]              最近の活動記録を表示
  node src/cli.mjs promises                       公約一覧（ID確認用）
  node src/cli.mjs promise-add                    公約を追加（対話 or --title ...）
  node src/cli.mjs promise-update <id> ...        公約を更新（--status/--progress/--title/--description）
  node src/cli.mjs promise-delete <id>            公約を削除
  node src/cli.mjs suggest-list                   目安箱一覧（--status で絞り込み）
  node src/cli.mjs suggest-reply <id> <返信文>    目安箱に返信（--status で状態も変更）
  node src/cli.mjs form-list                      アンケート一覧と回答数
  node src/cli.mjs form-create <file.json>         アンケートを作成
  node src/cli.mjs form-close <id>                アンケートを締め切る
  node src/cli.mjs generate --file inbox/x.md     記事の下書きを生成
  node src/cli.mjs prompt --file inbox/x.md       AIに貼るプロンプトを書き出す（キー不要）
  node src/cli.mjs import <返答.json> --source inbox/x.md   AIの返答を取り込む
  node src/cli.mjs preview <draft.json>           プレビューHTMLを再生成（latest可）
  node src/cli.mjs publish <draft.json> --yes     下書きを公開（latest可）
  node src/cli.mjs run [--auto]                   inbox/ をまとめて処理
  node src/cli.mjs delete <act-id> --yes          投稿を削除（取り消し不可）

generate のオプション:
  --category <${CATEGORIES.join("|")}>
  --date YYYY-MM-DD
  --no-ai                 AIを使わずテンプレート生成（要 title/subtitle）
  --out <dir>             下書きの保存先（既定: drafts/）

publish のオプション:
  --yes                   確認なしで公開
  --dry-run               書き込まず内容だけ表示
  --no-notice             サイト内のお知らせ（ポップアップ）を更新しない
  --force                 同一タイトルでも公開する

run のオプション:
  --auto                  生成後そのまま公開（既定は下書きのみ）
  --no-ai                 AIなしで生成
`);
}

function makeDraftId() {
  return `act-${Date.now()}`;
}

async function cmdDoctor() {
  console.log("接続確認をしています...");
  const store = createStore(config);
  const settings = await store.getDoc("site_settings/main");
  console.log(`✓ site_settings 読み取り OK（管理者パスワード設定: ${settings?.admin_password ? "あり" : "なし"}）`);

  const rows = await store.query("activity_records", { limit: 1 });
  console.log(`✓ activity_records 読み取り OK（最新: ${rows[0]?.title || "なし"}）`);

  const promises = await store.query("promises", { limit: 1 });
  console.log(`✓ promises 読み取り OK（${promises.length ? "データあり" : "なし"}）`);

  const testPath = "_opencode_check/doctor";
  await store.createDoc(testPath, { at: new Date().toISOString(), note: "temporary" });
  await store.deleteDoc(testPath);
  console.log("✓ 書き込みテスト OK（テスト用ドキュメントは削除済み）");

  console.log("\nすべて正常です。");
  console.log(`投稿先: ${config.site.baseUrl}/admin`);
}

async function cmdList(opts) {
  const store = createStore(config);
  const limit = Number(opts.limit || 10);
  const rows = await store.query("activity_records", {
    orderBy: { field: "date", direction: "DESCENDING" },
    limit,
  });
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const row of rows) {
    console.log(`${row.date}  ${row.category.padEnd(3, "　")}  ${row.id}\n  ${row.title}`);
  }
  if (!rows.length) console.log("投稿はまだありません。");
}

async function cmdPromises() {
  const store = createStore(config);
  const rows = await store.query("promises", { limit: 100 });
  rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const p of rows) {
    console.log(`#${String(p.order ?? "").padStart(2, "0")}  ${p.id}  [${p.status || ""}] ${p.title}`);
  }
}

async function cmdPromiseAdd(opts) {
  const store = createStore(config);
  const existing = await store.query("promises", { limit: 100 });
  const nextOrder = existing.reduce((m, p) => Math.max(m, Number(p.order || 0)), 0) + 1;

  let title, category, status, progress, order, description;

  if (opts.title) {
    title = String(opts.title).trim();
    category = opts.category || "学習環境";
    status = opts.status || "計画中";
    progress = opts.progress !== undefined ? Number(opts.progress) : 0;
    order = opts.order !== undefined ? Number(opts.order) : nextOrder;
    description = opts.description || "";
  } else {
    const rl = readline.createInterface({ input, output });
    const ask = async (q) => (await rl.question(q)).trim();
    try {
      console.log("=== 公約を追加 ===");
      title = await ask("タイトル（必須）: ");
      if (!title) throw new Error("タイトルは必須です");
      category = (await ask("カテゴリ [学習環境] (学習環境/行事/施設/交流/制度/その他): ")) || "学習環境";
      status = (await ask("状態 [計画中] (計画中/進行中/完了/保留): ")) || "計画中";
      const progressRaw = await ask("進捗 % [0]: ");
      progress = progressRaw ? Number(progressRaw) : 0;
      if (isNaN(progress) || progress < 0 || progress > 100) throw new Error("進捗は 0〜100 で入力してください");
      const orderRaw = await ask(`順序 [${nextOrder}]: `);
      order = orderRaw ? Number(orderRaw) : nextOrder;
      console.log("説明（空行で終了）:");
      const descLines = [];
      for (;;) {
        const line = await rl.question("> ");
        if (!line.trim()) break;
        descLines.push(line);
      }
      description = descLines.join("\\n").trim();

      const ok = await ask(`\\n「${title}」を追加しますか？ (yes/N): `);
      if (ok.toLowerCase() !== "yes" && ok.toLowerCase() !== "y") {
        console.log("中止しました。");
        return;
      }
    } finally {
      rl.close();
    }
  }

  if (!title) throw new Error("タイトルは必須です");
  if (isNaN(progress) || progress < 0 || progress > 100) throw new Error("進捗は 0〜100 で入力してください");

  const id = `promise-${Date.now()}`;
  const doc = { id, title, category, status, progress, order, description };
  await store.createDoc(`promises/${id}`, doc);
  console.log("\\n✓ 公約を追加しました");
  console.log(`${id}  #${String(order).padStart(2, "0")}  [${status}] ${title}  (${progress}%)`);
  return id;
}

async function cmdPromiseDelete(opts) {
  const id = opts._[0];
  if (!id) throw new Error("公約IDを指定してください");
  const store = createStore(config);
  const doc = await store.getDoc(`promises/${id}`);
  if (!doc) throw new Error(`公約が見つかりません: ${id}`);
  if (!opts.yes) {
    const rl = readline.createInterface({ input, output });
    const ok = (await rl.question(`${id} (${doc.title}) を削除しますか？ (yes/N): `)).trim();
    rl.close();
    if (ok.toLowerCase() !== "yes" && ok.toLowerCase() !== "y") { console.log("中止しました。"); return; }
  }
  await store.deleteDoc(`promises/${id}`);
  console.log(`✓ 削除しました: ${id}`);
}

async function cmdPromiseUpdate(opts) {
  const id = opts._[0];
  if (!id) throw new Error("公約IDを指定してください");
  const store = createStore(config);
  const doc = await store.getDoc(`promises/${id}`);
  if (!doc) throw new Error(`公約が見つかりません: ${id}`);
  const patch = {};
  if (opts.title) patch.title = String(opts.title);
  if (opts.category) patch.category = String(opts.category);
  if (opts.status) patch.status = String(opts.status);
  if (opts.progress !== undefined) {
    const p = Number(opts.progress);
    if (isNaN(p) || p < 0 || p > 100) throw new Error("進捗は 0〜100");
    patch.progress = p;
  }
  if (opts.description) patch.description = String(opts.description);
  if (Object.keys(patch).length === 0) throw new Error("更新内容がありません（--title/--category/--status/--progress/--description）");
  await store.updateDoc(`promises/${id}`, patch);
  console.log(`✓ 更新しました: ${id}`);
  console.log(JSON.stringify(patch, null, 2));
}

async function cmdSuggestList(opts) {
  const store = createStore(config);
  let rows = await store.query("suggestions", { limit: Number(opts.limit || 50) });
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  rows.sort((a, b) => String(b.created_date || "").localeCompare(String(a.created_date || "")));
  if (!rows.length) {
    console.log("目安箱の投稿はありません。");
    return;
  }
  for (const s of rows) {
    console.log(`\\n${s.id}  [${s.status || ""}] ${s.category || ""}  ${String(s.content || "").slice(0, 50)}`);
    console.log(`   作者: ${s.is_anonymous ? "匿名" : s.author_name || "-"}  公開: ${s.is_public ?? "-"}  いいね: ${s.likes ?? 0}`);
    if (s.reply) console.log(`   ↳ 返信: ${String(s.reply).slice(0, 80)}`);
    else console.log("   ↳ (未返信)");
  }
  console.log(`\\n合計: ${rows.length}件`);
}

async function cmdSuggestReply(opts) {
  const id = opts._[0];
  if (!id) throw new Error("目安箱IDを指定してください: suggest-reply <id> <返信文>");
  let replyText = opts._.slice(1).join(" ").trim();
  if (!replyText) {
    const rl = readline.createInterface({ input, output });
    replyText = (await rl.question("返信文: ")).trim();
    rl.close();
  }
  if (!replyText) throw new Error("返信文が空です");
  const status = opts.status || "対応済";
  const store = createStore(config);
  const doc = await store.getDoc(`suggestions/${id}`);
  if (!doc) throw new Error(`目安箱が見つかりません: ${id}`);
  await store.updateDoc(`suggestions/${id}`, { reply: replyText, status });
  console.log(`✓ 返信しました: ${id} → ${status}`);
  console.log(`  投稿: ${String(doc.content || "").slice(0, 60)}`);
  console.log(`  ↳ ${replyText}`);
}

async function cmdFormCreate(opts) {
  const file = opts._[0];
  if (!file) throw new Error("JSONファイルを指定してください: form create forms/x.json");
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) throw new Error(`ファイルが見つかりません: ${abs}`);
  const data = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (!data.title) throw new Error("title は必須です");
  if (!Array.isArray(data.questions) || !data.questions.length) throw new Error("questions は配列で1件以上必要です");
  for (const q of data.questions) {
    if (!q.id || !q.label || !q.type) throw new Error("各質問に id, label, type が必要です");
    if (q.type !== "text" && (!Array.isArray(q.options) || !q.options.length)) {
      throw new Error(`質問 ${q.id} に options が必要です`);
    }
  }
  const store = createStore(config);
  const id = data.id || `form-${Date.now()}`;
  const doc = {
    id,
    title: data.title,
    description: data.description || "",
    is_open: data.is_open !== false,
    due_date: data.due_date || "",
    allow_late_submission: data.allow_late_submission !== false,
    created_date: data.created_date || todayJst(),
    questions: data.questions,
  };
  await store.createDoc(`forms/${id}`, doc);
  console.log(`✓ アンケートを作成しました: ${id}`);
  console.log(`  ${doc.title}  [${doc.is_open ? "受付中" : "締切"}]  質問: ${doc.questions.length}件`);
}

async function cmdFormClose(opts) {
  const id = opts._[0];
  if (!id) throw new Error("アンケートIDを指定してください");
  const store = createStore(config);
  const doc = await store.getDoc(`forms/${id}`);
  if (!doc) throw new Error(`アンケートが見つかりません: ${id}`);
  await store.updateDoc(`forms/${id}`, { is_open: false });
  console.log(`✓ 締め切りました: ${id} (${doc.title})`);
}

async function cmdFormList() {
  const store = createStore(config);
  const forms = await store.query("forms", { limit: 50 });
  const resps = await store.query("form_responses", { limit: 200 });
  if (!forms.length) { console.log("アンケートはありません。"); return; }
  for (const f of forms) {
    const n = resps.filter((r) => r.form_id === f.id).length;
    console.log(`\\n${f.id}  [${f.is_open ? "受付中" : "締切"}] ${f.title}`);
    console.log(`   説明: ${String(f.description || "").slice(0, 60)}`);
    console.log(`   期限: ${f.due_date || "-"}  質問: ${f.questions?.length ?? 0}件  回答: ${n}件`);
  }
}

async function buildDraft(file, opts) {
  const note = readNote(file);
  const meta = { ...note.meta };
  if (opts.category) meta.category = opts.category;
  if (opts.date) meta.date = opts.date;

  const store = createStore(config);
  const promises = await store.query("promises", { limit: 100 });

  const article = await generateArticle({
    note: note.body,
    meta,
    promises,
    config,
    today: todayJst(),
    noAi: Boolean(opts["no-ai"]),
  });

  const draft = {
    id: makeDraftId(),
    ...article,
    meta: {
      source: path.relative(ROOT, file),
      generatedBy: article.generatedBy,
      createdAt: new Date().toISOString(),
    },
  };
  delete draft.generatedBy;

  validateDraft(draft);
  return draft;
}

function saveDraft(draft, outDir) {
  const dir = ensureDir(path.isAbsolute(outDir) ? outDir : path.join(ROOT, outDir));
  const file = path.join(dir, `${draft.date}-${draft.id}.json`);
  fs.writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
  return file;
}

async function cmdGenerate(opts) {
  const file = opts.file || opts._[0];
  if (!file) throw new Error("--file <メモ.md> を指定してください");
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) throw new Error(`ファイルが見つかりません: ${abs}`);

  const draft = await buildDraft(abs, opts);
  const saved = saveDraft(draft, opts.out || "drafts");
  const preview = writePreview(draft, config);

  if (draft.meta.generatedBy === "template" && !opts["no-ai"]) {
    console.log("※ GEMINI_API_KEY が未設定のため、テンプレート生成を使用しました。");
  }

  console.log("\n=== 下書きを作成しました ===");
  console.log(`タイトル: ${draft.title}`);
  console.log(`サブタイトル: ${draft.subtitle}`);
  console.log(`カテゴリ: ${draft.category} / 日付: ${draft.date}`);
  console.log(`本文: ${htmlToText(draft.description).length}文字`);
  console.log(`生成: ${draft.meta.generatedBy}`);
  console.log(`\n下書き: ${path.relative(ROOT, saved)}`);
  console.log(`プレビュー: ${path.relative(ROOT, preview)}`);
  console.log(`\n内容を確認して公開: node src/cli.mjs publish "${path.relative(ROOT, saved)}" --yes`);
}

async function confirm(message) {
  if (!input.isTTY) {
    throw new Error("確認が必要です。公開するには --yes を付けてください。");
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} (yes/N): `);
    return answer.trim().toLowerCase() === "yes" || answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function newestDraft() {
  const dir = path.join(ROOT, "drafts");
  if (!fs.existsSync(dir)) throw new Error("drafts/ に下書きがありません");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error("drafts/ に下書きがありません");
  return files[0];
}

function resolveDraftPath(file) {
  if (!file || file === "latest") return newestDraft();
  return path.isAbsolute(file) ? file : path.join(ROOT, file);
}

async function cmdPublish(opts) {
  const file = opts._[0] || (opts.latest ? "latest" : null);
  if (!file) throw new Error("下書きJSONを指定してください: publish drafts/xxx.json（最新は publish latest）");
  const abs = resolveDraftPath(file);
  if (!fs.existsSync(abs)) throw new Error(`下書きが見つかりません: ${abs}`);
  const draft = JSON.parse(fs.readFileSync(abs, "utf8"));

  const dryRun = Boolean(opts["dry-run"]);
  const notice = opts["no-notice"] ? false : undefined;

  if (!dryRun && !opts.yes) {
    console.log("--- 公開内容 ---");
    console.log(`タイトル: ${draft.title}`);
    console.log(`日付: ${draft.date} / カテゴリ: ${draft.category}`);
    console.log(`本文:\n${htmlToText(draft.description).slice(0, 400)}...\n`);
    const ok = await confirm("この内容で公開しますか？");
    if (!ok) {
      console.log("中止しました。");
      return;
    }
  }

  const result = await publishDraft(draft, config, { dryRun, notice, force: Boolean(opts.force) });

  if (result.dryRun) {
    console.log("=== dry-run: 書き込みは行っていません ===");
    console.log(JSON.stringify(result.document, null, 2));
    if (result.notice) console.log("お知らせ更新:", result.notice);
    return;
  }

  console.log("\n=== 公開しました ===");
  console.log(`URL: ${config.site.baseUrl}/activity/${result.document.id}`);
  if (result.notice) console.log("✓ サイト内のお知らせを更新しました");
  if (result.noticeError) console.log(`⚠ お知らせ更新に失敗: ${result.noticeError}`);
}

async function cmdPreview(opts) {
  const file = opts._[0] || (opts.latest ? "latest" : null);
  if (!file) throw new Error("下書きJSONを指定してください（最新は preview latest）");
  const abs = resolveDraftPath(file);
  if (!fs.existsSync(abs)) throw new Error(`下書きが見つかりません: ${abs}`);
  const draft = JSON.parse(fs.readFileSync(abs, "utf8"));
  const preview = writePreview(draft, config);
  console.log(preview);
}

/** キーなし運用: AIに貼るプロンプトを書き出す */
async function cmdPrompt(opts) {
  const file = opts.file || opts._[0];
  if (!file) throw new Error("--file <メモ.md> を指定してください");
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) throw new Error(`ファイルが見つかりません: ${abs}`);

  const note = readNote(abs);
  const meta = { ...note.meta };
  if (opts.category) meta.category = opts.category;
  if (opts.date) meta.date = opts.date;

  const store = createStore(config);
  const promises = await store.query("promises", { limit: 100 });
  const text = buildCopyPrompt({ note: note.body, meta, promises, today: todayJst() });

  const dir = ensureDir(path.join(ROOT, "drafts"));
  const out = path.join(dir, `${meta.date || todayJst()}-${Date.now()}.prompt.txt`);
  fs.writeFileSync(out, text, "utf8");

  console.log("AIに貼り付けるプロンプトを書き出しました:");
  console.log(`  ${path.relative(ROOT, out)}`);
  console.log("\n1. このファイルを開いて全文をコピー");
  console.log("2. ChatGPT / Gemini などに貼り付けて送信");
  console.log("3. 返ってきたJSONをファイルに保存");
  console.log(`4. node src/cli.mjs import <返答.json> --source ${path.relative(ROOT, abs)}`);
}

/** 手動で得たAIのJSONを取り込む */
async function cmdImport(opts) {
  const file = opts._[0];
  if (!file) throw new Error("AIの返答ファイル（.json / .txt）を指定してください");
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (file !== "-" && !fs.existsSync(abs)) throw new Error(`ファイルが見つかりません: ${abs}`);

  const text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(abs, "utf8");
  const raw = extractJson(text);
  if (!raw.description_html && raw.description) raw.description_html = raw.description;
  if (!raw.description_html && raw.body) raw.description_html = raw.body;

  let meta = {};
  let sourceLabel = "imported";
  if (opts.source) {
    const sourceAbs = path.isAbsolute(opts.source) ? opts.source : path.join(ROOT, opts.source);
    const note = readNote(sourceAbs);
    meta = { ...note.meta };
    sourceLabel = path.relative(ROOT, sourceAbs);
  }
  if (opts.category) meta.category = opts.category;
  if (opts.date) meta.date = opts.date;

  const store = createStore(config);
  const promises = await store.query("promises", { limit: 100 });
  const article = normalizeAiResult(raw, { meta, promises, today: todayJst() });

  const draft = {
    id: makeDraftId(),
    ...article,
    meta: { source: sourceLabel, generatedBy: "imported", createdAt: new Date().toISOString() },
  };
  delete draft.generatedBy;
  validateDraft(draft);

  const saved = saveDraft(draft, "drafts");
  const preview = writePreview(draft, config);

  console.log("\n=== 取り込みました ===");
  console.log(`タイトル: ${draft.title}`);
  console.log(`サブタイトル: ${draft.subtitle}`);
  console.log(`カテゴリ: ${draft.category} / 日付: ${draft.date}`);
  console.log(`下書き: ${path.relative(ROOT, saved)}`);
  console.log(`プレビュー: ${path.relative(ROOT, preview)}`);
  console.log(`\n公開: node src/cli.mjs publish "${path.relative(ROOT, saved)}" --yes`);
}

async function cmdStatus() {
  const provider = resolveProvider(config);
  const providerLabel =
    provider.name === "template"
      ? "テンプレート（AIキー未設定）"
      : `${provider.name}:${provider.model}`;

  const inbox = listNotes(path.join(ROOT, "inbox"));
  const draftsDir = path.join(ROOT, "drafts");
  const drafts = fs.existsSync(draftsDir)
    ? fs.readdirSync(draftsDir).filter((f) => f.endsWith(".json")).sort()
    : [];

  console.log(`AI          : ${providerLabel}`);
  console.log(`inbox       : ${inbox.length}件`);
  console.log(`下書き      : ${drafts.length}件`);
  for (const f of drafts.slice(-5)) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(draftsDir, f), "utf8"));
      console.log(`  - ${d.date}  ${d.title}`);
    } catch {
      console.log(`  - ${f}`);
    }
  }

  const store = createStore(config);
  const posts = await store.query("activity_records", {
    orderBy: { field: "date", direction: "DESCENDING" },
    limit: 5,
  });
  console.log("\n最近の投稿:");
  for (const p of posts) console.log(`  ${p.date}  ${p.title}`);
}

/** 対話形式で1件つくる（非エンジニア向け） */
async function cmdNew() {
  const provider = resolveProvider(config);
  const hasAi = provider.name !== "template";
  const rl = readline.createInterface({ input, output });
  const ask = async (q) => (await rl.question(q)).trim();

  try {
    console.log("=== 新しい活動記録 ===");
    console.log(`AI生成: ${hasAi ? `${provider.name}:${provider.model}` : "なし（テンプレート）"}\n`);

    const category = (await ask(`カテゴリ (${CATEGORIES.join(" / ")}) [広報]: `)) || "広報";
    if (!CATEGORIES.includes(category)) throw new Error(`カテゴリは ${CATEGORIES.join(" / ")} から選んでください`);

    const date = (await ask(`日付 (YYYY-MM-DD) [${todayJst()}]: `)) || todayJst();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日付は YYYY-MM-DD 形式で入力してください");

    const title = await ask("タイトル（空欄ならAIが作成）: ");
    const subtitle = await ask("サブタイトル（空欄ならAIが作成）: ");
    if (!hasAi && (!title || !subtitle)) {
      throw new Error("AIキーが未設定の場合は、タイトルとサブタイトルを入力してください");
    }

    console.log("\n内容メモを入力してください（空行で終了）:");
    const lines = [];
    for (;;) {
      const line = await rl.question("> ");
      if (!line.trim()) break;
      lines.push(line);
    }
    const note = lines.join("\n").trim();
    if (!note) throw new Error("内容メモが空です");

    const store = createStore(config);
    const promises = await store.query("promises", { limit: 100 });
    const article = await generateArticle({
      note,
      meta: { category, date, title, subtitle },
      promises,
      config,
      today: todayJst(),
      noAi: false,
    });

    const draft = {
      id: makeDraftId(),
      ...article,
      meta: { source: "interactive", generatedBy: article.generatedBy, createdAt: new Date().toISOString() },
    };
    delete draft.generatedBy;
    validateDraft(draft);

    const saved = saveDraft(draft, "drafts");
    const preview = writePreview(draft, config);

    console.log("\n=== 下書き ===");
    console.log(`タイトル: ${draft.title}`);
    console.log(`サブタイトル: ${draft.subtitle}`);
    console.log(`カテゴリ: ${draft.category} / 日付: ${draft.date}`);
    console.log(`本文:\n${htmlToText(draft.description)}\n`);
    console.log(`プレビュー: ${path.relative(ROOT, preview)}`);

    const answer = await ask("\nこの内容で公開しますか？ (yes/N): ");
    if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
      console.log(`\n下書きとして保存しました: ${path.relative(ROOT, saved)}`);
      console.log(`後で公開: node src/cli.mjs publish "${path.relative(ROOT, saved)}" --yes`);
      return;
    }

    const result = await publishDraft(draft, config, {});
    console.log(`\n公開しました: ${config.site.baseUrl}/activity/${result.document.id}`);
    if (result.notice) console.log("✓ サイト内のお知らせを更新しました");
    if (result.noticeError) console.log(`⚠ お知らせ更新に失敗: ${result.noticeError}`);
  } finally {
    rl.close();
  }
}

async function cmdRun(opts) {
  const inbox = path.join(ROOT, "inbox");
  const files = listNotes(inbox);
  if (!files.length) {
    console.log("inbox/ に .md がありません。");
    return;
  }
  const auto = Boolean(opts.auto) || config.run.autoPublish;
  const limit = Number(opts.limit || 5);
  let count = 0;

  for (const file of files.slice(0, limit)) {
    console.log(`\n処理中: ${path.relative(ROOT, file)}`);
    try {
      const draft = await buildDraft(file, opts);
      const saved = saveDraft(draft, "drafts");
      writePreview(draft, config);
      console.log(`  下書き: ${path.relative(ROOT, saved)}`);

      if (auto) {
        const result = await publishDraft(draft, config);
        console.log(`  公開: ${config.site.baseUrl}/activity/${result.document.id}`);
      }

      if (config.run.moveProcessed) {
        const dir = ensureDir(path.join(inbox, "processed"));
        fs.renameSync(file, path.join(dir, path.basename(file)));
      }
      count++;
    } catch (err) {
      console.error(`  失敗: ${err.message}`);
      logLine("RUN_FAILED", path.relative(ROOT, file), err.message);
    }
  }
  console.log(`\n完了: ${count}件`);
}

async function cmdDelete(opts) {
  const id = opts._[0];
  if (!id) throw new Error("投稿IDを指定してください");
  if (!opts.yes) {
    const ok = await confirm(`${id} を削除しますか？取り消せません。`);
    if (!ok) return console.log("中止しました。");
  }
  const store = createStore(config);
  const doc = await store.getDoc(`activity_records/${id}`);
  if (!doc) throw new Error(`投稿が見つかりません: ${id}`);
  console.log(`削除: ${doc.date} ${doc.title}`);
  await store.deleteDoc(`activity_records/${id}`);
  logLine("DELETED", id, JSON.stringify(doc.title));
  console.log("削除しました。");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  switch (cmd) {
    case "doctor":
      return cmdDoctor();
    case "list":
      return cmdList(opts);
    case "promises":
      return cmdPromises();
    case "promise-add":
      return cmdPromiseAdd(opts);
    case "promise-delete":
      return cmdPromiseDelete(opts);
    case "promise-update":
      return cmdPromiseUpdate(opts);
    case "suggest-list":
      return cmdSuggestList(opts);
    case "suggest-reply":
      return cmdSuggestReply(opts);
    case "form-list":
      return cmdFormList();
    case "form-create":
      return cmdFormCreate(opts);
    case "form-close":
      return cmdFormClose(opts);
    case "generate":
      return cmdGenerate(opts);
    case "publish":
      return cmdPublish(opts);
    case "preview":
      return cmdPreview(opts);
    case "prompt":
      return cmdPrompt(opts);
    case "import":
      return cmdImport(opts);
    case "status":
      return cmdStatus();
    case "new":
      return cmdNew();
    case "run":
      return cmdRun(opts);
    case "delete":
      return cmdDelete(opts);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return printHelp();
    default:
      console.error(`不明なコマンド: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nエラー: ${err.message}`);
  process.exitCode = 1;
});
