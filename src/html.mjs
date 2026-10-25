const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h2", "h3", "h4", "ul", "ol", "li",
  "strong", "b", "em", "i", "a", "div", "span", "blockquote", "code",
]);

const STYLE_ALLOWED_TAGS = new Set(["div", "span", "p"]);

function filterAttributes(tag, attrText) {
  const attrs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(attrText))) {
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? "";
    if (name.startsWith("on")) continue;
    if (name === "href" && tag === "a") {
      const v = value.trim();
      if (/^(https?:\/\/|\/|#|mailto:)/i.test(v) && !/javascript:/i.test(v)) {
        attrs.push(`href="${v.replace(/"/g, "&quot;")}"`);
        attrs.push('target="_blank"', 'rel="noopener noreferrer"');
      }
      continue;
    }
    if ((name === "class" || name === "style") && STYLE_ALLOWED_TAGS.has(tag)) {
      if (/expression\s*\(|javascript:|url\s*\(\s*['"]?\s*javascript/i.test(value)) continue;
      attrs.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
    }
  }
  return attrs.length ? " " + attrs.join(" ") : "";
}

/** 許可タグ・許可属性だけを残す（XSS/レイアウト崩れ防止） */
export function sanitizeHtml(input) {
  let html = String(input ?? "");
  html = html.replace(/<\s*(script|style|iframe|object|embed|form|input|button|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  html = html.replace(/<\s*(script|style|iframe|object|embed|form|input|button|link|meta)\b[^>]*\/?>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (_full, slash, rawName, attrText) => {
    const tag = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (slash) return `</${tag}>`;
    if (tag === "br" || tag === "hr") return `<${tag}>`;
    return `<${tag}${filterAttributes(tag, attrText)}>`;
  });

  return html.trim();
}

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
