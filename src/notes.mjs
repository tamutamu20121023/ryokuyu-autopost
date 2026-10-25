import fs from "node:fs";
import path from "node:path";

/** 先頭の --- ... --- を簡易YAMLとして読む */
export function parseNote(raw) {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const meta = {};
  let body = text;

  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      const block = text.slice(4, end);
      body = text.slice(end + 4).replace(/^\n+/, "");
      for (const line of block.split("\n")) {
        const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (value.startsWith("[") && value.endsWith("]")) {
          meta[key] = value
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        } else if (value === "true" || value === "false") {
          meta[key] = value === "true";
        } else {
          meta[key] = value;
        }
      }
    }
  }

  return { meta, body: body.trim(), raw: text };
}

export function readNote(file) {
  return { ...parseNote(fs.readFileSync(file, "utf8")), file };
}

export function listNotes(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .sort()
    .map((f) => path.join(dir, f));
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

/** Markdown（最小限）→ サイトが受け付けるHTML */
export function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      // サイトの記事本文は h3 を標準の見出しとして使う（h1は使わない）
      const depth = heading[1].length;
      const level = depth === 1 ? 2 : depth === 4 ? 4 : 3;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** サイトの記事冒頭で使われている強調ボックス */
export function summaryBox(label, text, tone = "green") {
  const palette =
    tone === "orange"
      ? { bg: "#FEF5EB", border: "#CE6E14" }
      : { bg: "#EAF2ED", border: "#396B4E" };
  return `<div style="margin-top:16px;margin-bottom:16px;padding:14px 18px;border-radius:14px;border:1.5px solid ${palette.border};background:${palette.bg};">
  <div style="font-weight:bold;font-size:13px;margin-bottom:6px;color:${palette.border};">📌 ${escapeHtml(label)}</div>
  <div style="font-weight:bold;font-size:16px;color:#19261F;">${escapeHtml(text)}</div>
</div>`;
}
