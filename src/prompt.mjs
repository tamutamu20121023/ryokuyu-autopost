import { sanitizeHtml } from "./html.mjs";

export const CATEGORIES = ["会議", "イベント", "施策", "点検", "広報", "その他"];

export function buildSystemPrompt() {
  return `あなたは「東京学芸大学附属世田谷中学校 緑友役員会」の広報担当です。
生徒会ポータルの「活動の記録（活動ブログ）」に掲載する記事を、担当者から渡された素材メモだけを根拠に書きます。

# 絶対に守るルール
- 素材メモに書かれていない事実を創作しない。日付・人数・金額・人名・結果を推測で補わない。
- 素材が不足している場合は、書ける範囲だけを簡潔にまとめる（無理に文字数を埋めない）。
- 中学生と保護者・教職員が読む文章。やさしい日本語で、威圧的・宣伝的な表現を避ける。
- 個人情報（生徒の氏名・学籍番号・連絡先・成績など）は書かない。素材に含まれていても役職と学年までにする。
- 誰かを批判・断定する表現、政治的な主張は書かない。
- タイトルは40文字以内。既存記事と同じく、必要なら【後期役員会】などの接頭辞を付ける。
- サブタイトルは50文字以内。記事の要点を1文で。
- 本文は300〜700文字程度。見出し（h3）と箇条書きを使い、最後に「緑友役員会」としての短い締めの一文を置く。

# 本文HTMLの形式
次のタグだけを使う: <p> <h3> <ul> <ol> <li> <strong> <em> <a> <br> <div> <span>
Markdownは使わない。必ずHTMLで出力する。
冒頭に、サイト標準の強調ボックスを1つ入れる:
<div style="margin-top:16px;margin-bottom:16px;padding:14px 18px;border-radius:14px;border:1.5px solid #396B4E;background:#EAF2ED;">
  <div style="font-weight:bold;font-size:13px;margin-bottom:6px;color:#396B4E;">📌 ポイント</div>
  <div style="font-weight:bold;font-size:16px;color:#19261F;">（記事の要点を1文）</div>
</div>
その後に <p> 段落、<h3> 見出し、<ul><li> 箇条書きを続ける。
装飾用のclass属性は不要。style属性は上のボックス以外では使わない。

# 文体の参考（実際の記事）
例1:
タイトル: 【後期役員会】第１回　緑友会議
サブタイトル: 10/21 会議内容について
本文: 10月21日に役員会室にて会議を実施しました。見出し「【討議アジェンダ】」の下に、決定した行動目標や、企画書提出の協力依頼を箇条書きで整理。最後に「以上。（サイト更新責任者）」。

例2:
タイトル: 【最終更新 2026_10_23】後期緑友会の公約更新をいたしました。
サブタイトル: 後期緑友会の行動内容についてが決定しました。
本文: 強調ボックスで「緑友会の公約一覧を最新のものに更新しました！」と示し、本文で「当サイトの公約一覧から最新の公約一覧をご確認になれます！」と案内。最後に「これからも緑友役員会をどうぞよろしくお願いいたします。」

# カテゴリ
${CATEGORIES.join(" / ")} のいずれか1つ。会議=会議・審議、イベント=行事、施策=取り組み、点検=施設点検、広報=お知らせ・更新報告、その他=上記以外。`;
}

export function buildUserPrompt({ note, meta, promises, today }) {
  const promiseList = promises.length
    ? promises
        .map((p) => `- ${p.id} | #${String(p.order ?? "").padStart(2, "0")} | ${p.title}（${p.status ?? ""}）`)
        .join("\n")
    : "（公約データなし）";

  return `# 素材メモ
${note}

# 担当者からの指定（あれば優先）
- 投稿日: ${meta.date || today}
- カテゴリ希望: ${meta.category || "指定なし"}
- タイトル希望: ${meta.title || "指定なし"}
- サブタイトル希望: ${meta.subtitle || "指定なし"}
- 関連する公約ID: ${Array.isArray(meta.promise_ids) ? meta.promise_ids.join(", ") : meta.promise_ids || "指定なし"}
- 画像URL: ${meta.image_url || "指定なし"}

# 関連付けられる公約（この一覧のIDだけを使う）
${promiseList}

# 出力
上の素材だけを根拠に、活動記録の記事を1本作成してください。
関連する公約が明確な場合だけ promise_ids に入れる（無理に対応させない）。該当なしなら空配列。
image_url は指定がなければ空文字。`;
}

export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    subtitle: { type: "STRING" },
    category: { type: "STRING", enum: CATEGORIES },
    description_html: { type: "STRING" },
    promise_ids: { type: "ARRAY", items: { type: "STRING" } },
    image_url: { type: "STRING" },
  },
  required: ["title", "subtitle", "category", "description_html", "promise_ids", "image_url"],
};

export function normalizeAiResult(result, { meta, promises, today }) {
  const category = CATEGORIES.includes(result.category)
    ? result.category
    : CATEGORIES.includes(meta.category)
      ? meta.category
      : "広報";

  const allowedPromiseIds = new Set(promises.map((p) => p.id));
  let promiseIds = Array.isArray(result.promise_ids) ? result.promise_ids.filter((id) => allowedPromiseIds.has(id)) : [];

  if (Array.isArray(meta.promise_ids)) {
    promiseIds = [...new Set([...promiseIds, ...meta.promise_ids.filter((id) => allowedPromiseIds.has(id))])];
  } else if (meta.promise_ids && allowedPromiseIds.has(meta.promise_ids)) {
    promiseIds = [...new Set([...promiseIds, meta.promise_ids])];
  }

  return {
    title: String(meta.title || result.title || "").trim().slice(0, 80),
    subtitle: String(meta.subtitle || result.subtitle || "").trim().slice(0, 100),
    category,
    date: meta.date || today,
    description: sanitizeHtml(result.description_html || ""),
    promise_ids: promiseIds,
    image_url: String(meta.image_url || result.image_url || "").trim(),
  };
}
