import { loadConfig } from "./env.mjs";

/**
 * サイトが公開している Firebase 設定（フロントのJSに埋め込まれているもの）を
 * そのまま利用する。管理者パスワードや秘密鍵は不要。
 */

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, encodeValue(v)])
        ),
      },
    };
  }
  throw new Error(`Firestoreに変換できない値です: ${String(value)}`);
}

function decodeValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if ("mapValue" in value) {
    return decodeFields(value.mapValue.fields || {});
  }
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("referenceValue" in value) return value.referenceValue;
  return value;
}

function decodeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) out[key] = decodeValue(value);
  return out;
}

export function createStore(config = loadConfig()) {
  const { projectId, databaseId, apiKey, origin } = config.site;
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents`;
  const headers = {
    "content-type": "application/json",
    origin,
    referer: `${origin}/`,
  };

  async function request(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非JSONはそのまま */
    }
    if (!res.ok) {
      const message = json?.error?.message || text.slice(0, 300);
      const err = new Error(`Firestore ${res.status}: ${message}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    base,

    /** 単一ドキュメント取得（存在しなければ null） */
    async getDoc(docPath) {
      const res = await fetch(`${base}/${docPath}?key=${apiKey}`, { headers });
      if (res.status === 404) return null;
      const text = await res.text();
      if (!res.ok) throw new Error(`Firestore ${res.status}: ${text.slice(0, 300)}`);
      const json = JSON.parse(text);
      return { id: docPath.split("/").pop(), ...decodeFields(json.fields) };
    },

    /** コレクション検索 */
    async query(collectionId, { where, orderBy, limit = 20 } = {}) {
      const structuredQuery = {
        from: [{ collectionId }],
        limit,
      };
      if (where) {
        structuredQuery.where = {
          fieldFilter: {
            field: { fieldPath: where.field },
            op: where.op || "EQUAL",
            value: encodeValue(where.value),
          },
        };
      }
      if (orderBy) {
        structuredQuery.orderBy = [
          { field: { fieldPath: orderBy.field }, direction: orderBy.direction || "DESCENDING" },
        ];
      }
      const arr = await request(`${base}:runQuery?key=${apiKey}`, {
        method: "POST",
        body: JSON.stringify({ structuredQuery }),
      });
      return (arr || [])
        .filter((row) => row.document)
        .map((row) => ({
          id: row.document.name.split("/").pop(),
          ...decodeFields(row.document.fields),
        }));
    },

    /** 新規作成（同じIDが存在したら失敗） */
    async createDoc(docPath, data) {
      const fields = Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, encodeValue(v)])
      );
      const json = await request(
        `${base}/${docPath}?key=${apiKey}&currentDocument.exists=false`,
        { method: "PATCH", body: JSON.stringify({ fields }) }
      );
      return json;
    },

    /** 既存ドキュメントの一部フィールドだけ更新 */
    async updateDoc(docPath, data) {
      const keys = Object.keys(data).filter((k) => data[k] !== undefined);
      if (keys.length === 0) return null;
      const mask = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
      const fields = Object.fromEntries(keys.map((k) => [k, encodeValue(data[k])]));
      return request(`${base}/${docPath}?key=${apiKey}&${mask}`, {
        method: "PATCH",
        body: JSON.stringify({ fields }),
      });
    },

    async deleteDoc(docPath) {
      return request(`${base}/${docPath}?key=${apiKey}`, { method: "DELETE" });
    },
  };
}
