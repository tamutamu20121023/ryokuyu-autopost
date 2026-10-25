import fs from "node:fs";
import path from "node:path";
import { createStore } from "./firestore.mjs";
import { CATEGORIES } from "./prompt.mjs";
import { sanitizeHtml, htmlToText } from "./html.mjs";
import { ROOT, ensureDir, logLine } from "./env.mjs";

export function validateDraft(draft) {
  const errors = [];
  if (!draft.title || !String(draft.title).trim()) errors.push("title が空です");
  if (!draft.subtitle || !String(draft.subtitle).trim()) errors.push("subtitle が空です");
  if (!CATEGORIES.includes(draft.category)) {
    errors.push(`category は ${CATEGORIES.join(" / ")} のいずれかにしてください（現在: ${draft.category}）`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date || "")) errors.push("date は YYYY-MM-DD 形式にしてください");
  const text = htmlToText(draft.description || "");
  if (text.length < 20) errors.push("本文が短すぎます（20文字以上）");
  if (text.length > 4000) errors.push("本文が長すぎます（4000文字以下）");
  if (!Array.isArray(draft.promise_ids)) errors.push("promise_ids は配列にしてください");
  if (errors.length) {
    const err = new Error("下書きに問題があります:\n- " + errors.join("\n- "));
    err.validation = errors;
    throw err;
  }
  return true;
}

export function buildDocument(draft) {
  const doc = {
    id: draft.id,
    date: draft.date,
    title: String(draft.title).trim(),
    subtitle: String(draft.subtitle).trim(),
    category: draft.category,
    description: sanitizeHtml(draft.description),
    promise_ids: draft.promise_ids || [],
  };
  if (draft.promise_ids?.length) doc.promise_id = draft.promise_ids[0];
  if (draft.image_url) doc.image_url = String(draft.image_url).trim();
  return doc;
}

export async function findDuplicate(store, title) {
  const rows = await store.query("activity_records", {
    where: { field: "title", op: "EQUAL", value: title },
    limit: 5,
  });
  return rows[0] || null;
}

export function buildNotice(draft, config) {
  const y = draft.date.slice(0, 4);
  const m = String(Number(draft.date.slice(5, 7)));
  const d = String(Number(draft.date.slice(8, 10)));
  return {
    modal_message_title: config.publish.noticeTitle,
    modal_message_content: `活動ブログを更新しました！\n投稿名：${draft.title}\n投稿日：${y}年${m}月${d}日`,
    modal_message_button_text: config.publish.noticeButtonText,
    modal_message_button_url: `/activity/${draft.id}`,
  };
}

// Web Push機能は運営方針により削除済み（更新はサイト内お知らせポップアップのみ）

export async function publishDraft(draft, config, { dryRun = false, notice, force = false } = {}) {
  validateDraft(draft);
  const store = createStore(config);
  const doc = buildDocument(draft);

  if (!force) {
    const duplicate = await findDuplicate(store, doc.title);
    if (duplicate) {
      throw new Error(
        `同じタイトルの記事が既にあります: ${duplicate.id} / ${duplicate.title}\n` +
          "意図的に再投稿する場合は --force を付けてください。"
      );
    }
  }

  const useNotice = notice ?? config.publish.updateSiteNotice;
  const noticeData = buildNotice(draft, config);

  if (dryRun) {
    return { dryRun: true, document: doc, notice: useNotice ? noticeData : null };
  }

  await store.createDoc(`activity_records/${doc.id}`, doc);
  logLine("PUBLISHED", doc.id, JSON.stringify(doc.title));

  const results = { document: doc, notice: null };

  if (useNotice) {
    try {
      await store.updateDoc("site_settings/main", noticeData);
      results.notice = noticeData;
      logLine("NOTICE_UPDATED", doc.id);
    } catch (err) {
      results.noticeError = err.message;
      logLine("NOTICE_FAILED", doc.id, err.message);
    }
  }

  return results;
}

export function writePreview(draft, config) {
  const dir = ensureDir(path.join(ROOT, "drafts"));
  const file = path.join(dir, `${draft.id}.preview.html`);
  const safeTitle = String(draft.title).replace(/</g, "&lt;");
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} | プレビュー</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Noto+Serif+JP:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light}
body{margin:0;background:#FAF8F5;color:#19261F;font-family:'Noto Sans JP',sans-serif;line-height:1.9}
.wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px}
.tag{display:inline-block;font-size:11px;letter-spacing:.08em;color:#396B4E;border:1px solid #396B4E33;background:#EAF2ED;padding:4px 10px;border-radius:999px}
h1{font-family:'Noto Serif JP',serif;font-size:28px;line-height:1.5;margin:14px 0 8px}
.sub{color:#19261F99;font-size:15px;margin:0 0 18px}
.meta{display:flex;gap:14px;font-size:12px;color:#19261F80;border-bottom:1px solid #E4E1D8;padding-bottom:16px;margin-bottom:28px}
.article p{margin:0 0 1.1em}
.article h3{font-family:'Noto Serif JP',serif;font-size:19px;margin:1.8em 0 .6em;border-left:4px solid #396B4E;padding-left:10px}
.article ul,.article ol{padding-left:1.4em;margin:0 0 1.1em}
.article li{margin:.3em 0}
.article a{color:#396B4E}
.badge{margin-top:40px;padding:14px;border-radius:12px;background:#fff;border:1px solid #E4E1D8;font-size:12px;color:#19261F80}
</style></head>
<body><div class="wrap">
<span class="tag">${draft.category}</span>
<h1>${safeTitle}</h1>
<p class="sub">${String(draft.subtitle).replace(/</g, "&lt;")}</p>
<div class="meta"><span>${draft.date}</span><span>緑友役員会</span><span>ID: ${draft.id}</span></div>
<div class="article">${sanitizeHtml(draft.description)}</div>
<div class="badge">これは投稿前のプレビューです。公開URL: <a href="${config.site.baseUrl}/activity/${draft.id}">${config.site.baseUrl}/activity/${draft.id}</a></div>
</div></body></html>`;
  fs.writeFileSync(file, html, "utf8");
  return file;
}
