// ホテル空室監視: 楽天トラベル空室検索APIで config.json の各監視条件を確認し、新しく空いたら ntfy で通知する
// 環境変数: RAKUTEN_APP_ID, RAKUTEN_ACCESS_KEY, NTFY_TOPIC (任意: RAKUTEN_REFERER)
// 実行: node check.js        (--dry で通知せず結果だけ表示 / --fixture <file> でAPIの代わりにJSONファイルを使う)
//
// config.json の watches[] 1件 = 1つの監視条件。日程は次のどちらかで指定する
//   range:  { start, end, fullStay }  start〜end の各1泊 (+ fullStay=true なら全期間の連泊)
//   weekly: { weekdays, daysAhead, nights } 今日から daysAhead 日先までの指定曜日(0=日〜6=土)にチェックイン

const fs = require("fs");
const path = require("path");

const API_URL = "https://openapi.rakuten.co.jp/engine/api/Travel/VacantHotelSearch/20170426";
const STATE_FILE = path.join(__dirname, "state.json");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const fixtureIdx = args.indexOf("--fixture");
const FIXTURE = fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;

// 日付ユーティリティ(YYYY-MM-DD をUTCとして扱う)
const addDays = (ymd, n) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (ymd) => new Date(ymd + "T00:00:00Z").getUTCDay();
const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const mdLabel = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}(${"日月火水木金土"[weekday(ymd)]})`;
const stayLabel = (s) =>
  s.checkout === addDays(s.checkin, 1) ? `${mdLabel(s.checkin)}泊` : `${mdLabel(s.checkin)}〜${mdLabel(s.checkout)}連泊`;

// 監視条件から、確認する宿泊パターン(今日以降のみ)を作る
function buildStays(watch) {
  const stays = [];
  const today = todayJst();
  if (watch.range) {
    const { start, end, fullStay } = watch.range;
    for (let d = start; d < end; d = addDays(d, 1)) {
      if (d >= today) stays.push({ checkin: d, checkout: addDays(d, 1) });
    }
    if (fullStay && start >= today && addDays(start, 1) < end) stays.push({ checkin: start, checkout: end });
  }
  if (watch.weekly) {
    const { weekdays, daysAhead, nights = 1 } = watch.weekly;
    for (let i = 0; i <= daysAhead; i++) {
      const d = addDays(today, i);
      if (weekdays.includes(weekday(d))) stays.push({ checkin: d, checkout: addDays(d, nights) });
    }
  }
  return stays;
}

async function fetchVacancy(q) {
  if (FIXTURE) return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const params = new URLSearchParams({
    applicationId: process.env.RAKUTEN_APP_ID || "",
    accessKey: process.env.RAKUTEN_ACCESS_KEY || "",
    format: "json",
    formatVersion: "2",
    hotelNo: String(q.hotelNo),
    checkinDate: q.checkin,
    checkoutDate: q.checkout,
    adultNum: String(q.adultNum),
    roomNum: String(q.roomNum),
    searchPattern: "1",
    hits: "30",
  });
  // Webアプリケーション型のアプリは、登録した「許可されたWebサイト」の Origin/Referer が必要
  const site = process.env.RAKUTEN_REFERER || "https://github.com/";
  const headers = { Referer: site, Origin: new URL(site).origin };
  const res = await fetch(`${API_URL}?${params}`, { headers });
  const body = await res.json().catch(() => ({}));
  // 空室なしは 404 not_found で返る
  if (res.status === 404 && body.error === "not_found") return null;
  if (!res.ok) {
    const detail = body.error_description || (body.errors && body.errors.errorMessage) || body.error || "";
    throw new Error(`HTTP ${res.status} ${detail}`.trim());
  }
  return body;
}

// レスポンスから roomBasicInfo を持つ要素を全部拾う(formatVersion の違いに依存しないよう再帰で探す)
function extractRooms(json) {
  const rooms = [];
  // roomInfo は [{roomBasicInfo}, {dailyCharge}] のように兄弟要素で並ぶ
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      const basic = node.find((n) => n && n.roomBasicInfo);
      if (basic) {
        const charge = node.find((n) => n && n.dailyCharge);
        rooms.push({ ...basic.roomBasicInfo, dailyCharge: (charge && charge.dailyCharge) || {} });
        return;
      }
      return node.forEach(walk);
    }
    if (node.roomBasicInfo) {
      rooms.push({ ...node.roomBasicInfo, dailyCharge: node.dailyCharge || {} });
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(json);
  return rooms;
}

// roomKeywords が空なら全部屋が対象
const matchesTarget = (watch, room) => {
  const keywords = watch.roomKeywords || [];
  const text = `${room.roomName || ""} ${room.planName || ""}`;
  return keywords.length === 0 || keywords.some((k) => text.includes(k));
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { available: {}, errorNotified: false };
  }
}

async function notify(title, message, url) {
  if (DRY || !process.env.NTFY_TOPIC) {
    console.log(`[通知${DRY ? "(dry)" : "スキップ: NTFY_TOPIC未設定"}] ${title}\n${message}`);
    return;
  }
  // 日本語タイトルを送るため JSON 形式で投稿する
  const payload = { topic: process.env.NTFY_TOPIC, title, message, priority: 5, tags: ["hotel"] };
  if (url) payload.click = url;
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

async function main() {
  // 監視条件ごとの問い合わせを作る。同じホテル・日程・人数の問い合わせは1回にまとめる
  const queries = new Map();
  for (const watch of config.watches) {
    for (const stay of buildStays(watch)) {
      const qKey = [watch.hotelNo, stay.checkin, stay.checkout, watch.adultNum, watch.roomNum].join("_");
      if (!queries.has(qKey)) {
        queries.set(qKey, { ...stay, hotelNo: watch.hotelNo, adultNum: watch.adultNum, roomNum: watch.roomNum, watches: [] });
      }
      queries.get(qKey).watches.push(watch);
    }
  }
  if (queries.size === 0) {
    console.log("監視期間が終了しています");
    return;
  }

  const prev = loadState();
  const nowAvailable = {};
  const erroredKeys = [];
  const errors = [];

  for (const [qKey, q] of queries) {
    const watch = q.watches[0];
    const label = stayLabel(q);
    try {
      const json = await fetchVacancy(q);
      const rooms = json ? extractRooms(json).filter((r) => q.watches.some((w) => matchesTarget(w, r))) : [];
      console.log(`${watch.hotelLabel} ${label} 大人${q.adultNum}: ${rooms.length ? rooms.map((r) => r.roomName).join(" / ") : "空きなし"}`);
      for (const r of rooms) {
        nowAvailable[`${qKey}_${r.planId || ""}_${r.roomClass || r.roomName}`] = {
          hotelLabel: watch.hotelLabel,
          officialUrl: watch.officialUrl,
          label,
          roomName: r.roomName,
          total: r.dailyCharge.total,
          url: r.reserveUrl,
        };
      }
    } catch (e) {
      erroredKeys.push(qKey);
      errors.push(`${watch.hotelLabel} ${label}: ${e.message}`);
      console.error(`${watch.hotelLabel} ${label}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // APIへの連続アクセスを避ける
  }

  // 前回なかった空きだけ、ホテルごとにまとめて通知する
  const fresh = Object.entries(nowAvailable).filter(([k]) => !prev.available[k]).map(([, v]) => v);
  const byHotel = new Map();
  for (const v of fresh) byHotel.set(v.hotelLabel, [...(byHotel.get(v.hotelLabel) || []), v]);
  for (const [hotelLabel, items] of byHotel) {
    const lines = items.map((v) => `・${v.label} ${v.roomName}${v.total ? `(1泊目 ${Number(v.total).toLocaleString()}円)` : ""}`);
    const msg = [
      ...lines,
      "",
      "楽天で空きが出ました。公式でも空いている可能性があるので、公式サイトもすぐ確認してください。",
      items[0].officialUrl ? `公式: ${items[0].officialUrl}` : "",
    ].join("\n").trim();
    await notify(`${hotelLabel} 空きあり!`, msg, items[0].url);
  }

  // 全リクエストが失敗した時だけ1回通知(連続で通知しない)
  const allFailed = erroredKeys.length === queries.size;
  if (allFailed && !prev.errorNotified) {
    await notify("ホテル空室監視 エラー", errors.slice(0, 10).join("\n"));
  }

  // エラーになった問い合わせは前回の状態を引き継いで、復旧時の重複通知を防ぐ
  const kept = Object.fromEntries(
    Object.entries(prev.available).filter(([k]) => erroredKeys.some((q) => k.startsWith(q + "_")))
  );
  const next = {
    available: allFailed ? prev.available : { ...kept, ...nowAvailable },
    errorNotified: allFailed,
    checkedAt: new Date().toISOString(),
  };
  if (!DRY && !FIXTURE) fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
