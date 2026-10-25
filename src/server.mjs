import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadEnv, ensureDir } from "./env.mjs";
import { createStore } from "./firestore.mjs";
import { generateArticle, resolveProvider } from "./ai.mjs";
import { validateDraft, publishDraft, writePreview } from "./publish.mjs";
import { CATEGORIES } from "./prompt.mjs";
import { htmlToText } from "./html.mjs";

loadEnv();
const config = loadConfig();
const store = createStore(config);
const PORT = Number(process.env.PORT || 3000);

function todayJst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
function makeDraftId() {
  return `act-${Date.now()}`;
}
function saveDraft(draft, outDir) {
  const dir = ensureDir(path.isAbsolute(outDir) ? outDir : path.join(ROOT, outDir));
  const file = path.join(dir, `${draft.date}-${draft.id}.json`);
  fs.writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
  return file;
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" });
    return res.end();
  }

  if (pathname === "/" || pathname === "/index.html") {
    const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  // static files (drafts previews etc.)
  if (pathname.startsWith("/drafts/")) {
    const rel = pathname.slice(1);
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) {
      const ext = path.extname(abs).toLowerCase();
      const mime = ext === ".html" ? "text/html" : ext === ".json" ? "application/json" : "text/plain";
      res.writeHead(200, { "content-type": `${mime}; charset=utf-8` });
      return res.end(fs.readFileSync(abs));
    }
  }

  try {
    if (pathname === "/api/status" && req.method === "GET") {
      const provider = resolveProvider(config);
      const drafts = fs.readdirSync(path.join(ROOT, "drafts")).filter((f) => f.endsWith(".json"));
      const recent = await store.query("activity_records", { limit: 8, orderBy: { field: "date", direction: "DESCENDING" } });
      const inbox = fs.readdirSync(path.join(ROOT, "inbox")).filter((f) => f.endsWith(".md"));
      return json(res, 200, { ai: `${provider.name}:${provider.model}`, drafts, recentPosts: recent, inbox });
    }
    if (pathname === "/api/promises" && req.method === "GET") {
      const rows = await store.query("promises", { limit: 100 });
      rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return json(res, 200, rows);
    }
    if (pathname === "/api/suggestions" && req.method === "GET") {
      const rows = await store.query("suggestions", { limit: 100 });
      rows.sort((a, b) => String(b.created_date || "").localeCompare(String(a.created_date || "")));
      return json(res, 200, rows);
    }
    if (pathname === "/api/forms" && req.method === "GET") {
      const forms = await store.query("forms", { limit: 50 });
      const resps = await store.query("form_responses", { limit: 500 });
      const out = forms.map((f) => ({ ...f, responseCount: resps.filter((r) => r.form_id === f.id).length }));
      return json(res, 200, out);
    }
    if (pathname === "/api/drafts" && req.method === "GET") {
      const files = fs.readdirSync(path.join(ROOT, "drafts")).filter((f) => f.endsWith(".json"));
      const drafts = files.map((f) => {
        const d = JSON.parse(fs.readFileSync(path.join(ROOT, "drafts", f), "utf8"));
        return { file: f, id: d.id, title: d.title, date: d.date, category: d.category };
      });
      return json(res, 200, drafts);
    }
    if (pathname === "/api/draft" && req.method === "GET") {
      const file = url.searchParams.get("file");
      const abs = path.join(ROOT, "drafts", file);
      const d = JSON.parse(fs.readFileSync(abs, "utf8"));
      return json(res, 200, d);
    }
    if (pathname === "/api/generate" && req.method === "POST") {
      const body = await readBody(req);
      const note = body.note || "";
      const meta = body.meta || {};
      const p = await store.query("promises", { limit: 100 });
      const article = await generateArticle({ note, meta, promises: p, config, today: todayJst(), noAi: !!body.noAi });
      const draft = { id: makeDraftId(), ...article, meta: { source: "web", generatedBy: article.generatedBy, createdAt: new Date().toISOString() } };
      delete draft.generatedBy;
      validateDraft(draft);
      const saved = saveDraft(draft, "drafts");
      const preview = writePreview(draft, config);
      return json(res, 200, { draft, saved: path.relative(ROOT, saved), preview: path.relative(ROOT, preview) });
    }
    if (pathname === "/api/publish" && req.method === "POST") {
      const body = await readBody(req);
      const file = body.file;
      const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
      const draft = JSON.parse(fs.readFileSync(abs, "utf8"));
      const result = await publishDraft(draft, config, { dryRun: !!body.dryRun, notice: body.notice, force: !!body.force });
      return json(res, 200, result);
    }
    if (pathname === "/api/promise-add" && req.method === "POST") {
      const body = await readBody(req);
      const existing = await store.query("promises", { limit: 100 });
      const nextOrder = existing.reduce((m, p) => Math.max(m, Number(p.order || 0)), 0) + 1;
      const id = `promise-${Date.now()}`;
      const doc = { id, title: body.title, category: body.category || "学習環境", status: body.status || "計画中", progress: Number(body.progress || 0), order: body.order || nextOrder, description: body.description || "" };
      await store.createDoc(`promises/${id}`, doc);
      return json(res, 200, { id, doc });
    }
    if (pathname === "/api/promise-update" && req.method === "POST") {
      const body = await readBody(req);
      const patch = {};
      if (body.title) patch.title = body.title;
      if (body.category) patch.category = body.category;
      if (body.status) patch.status = body.status;
      if (body.progress !== undefined) patch.progress = Number(body.progress);
      if (body.description !== undefined) patch.description = body.description;
      await store.updateDoc(`promises/${body.id}`, patch);
      return json(res, 200, { ok: true, patch });
    }
    if (pathname === "/api/promise-delete" && req.method === "POST") {
      const body = await readBody(req);
      await store.deleteDoc(`promises/${body.id}`);
      return json(res, 200, { ok: true });
    }
    if (pathname === "/api/suggest-reply" && req.method === "POST") {
      const body = await readBody(req);
      await store.updateDoc(`suggestions/${body.id}`, { reply: body.reply, status: body.status || "対応済" });
      return json(res, 200, { ok: true });
    }
    if (pathname === "/api/form-create" && req.method === "POST") {
      const body = await readBody(req);
      const id = body.id || `form-${Date.now()}`;
      const doc = { id, title: body.title, description: body.description || "", is_open: body.is_open !== false, due_date: body.due_date || "", allow_late_submission: body.allow_late_submission !== false, created_date: body.created_date || todayJst(), questions: body.questions };
      await store.createDoc(`forms/${id}`, doc);
      return json(res, 200, { id, doc });
    }
    if (pathname === "/api/form-close" && req.method === "POST") {
      const body = await readBody(req);
      await store.updateDoc(`forms/${body.id}`, { is_open: false });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`緑友役員会ツール サーバー起動: http://localhost:${PORT}`);
  console.log("終了: Ctrl+C");
});
