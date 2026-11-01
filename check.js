// ミラコスタ空室監視: 楽天トラベル空室検索APIで対象部屋の空きを確認し、新しく空いたら ntfy で通知する
// 環境変数: RAKUTEN_APP_ID, RAKUTEN_ACCESS_KEY, NTFY_TOPIC (任意: RAKUTEN_REFERER)
// 実行: node check.js        (--dry で通知せず結果だけ表示 / --fixture <file> でAPIの代わりにJSONファイルを使う)

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
const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const mdLabel = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

// 確認する宿泊パターン: 期間内の各1泊 + 期間全体の連泊
function buildStays() {
  const stays = [];
  const today = todayJst();
  for (let d = config.periodStart; d < config.periodEnd; d = addDays(d, 1)) {
    if (d >= today) stays.push({ checkin: d, checkout: addDays(d, 1) });
  }
  if (config.checkFullStay && config.periodStart >= today && addDays(config.periodStart, 1) < config.periodEnd) {
    stays.push({ checkin: config.periodStart, checkout: config.periodEnd });
  }
  return stays;
}

async function fetchVacancy(stay) {
  if (FIXTURE) return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const params = new URLSearchParams({
    applicationId: process.env.RAKUTEN_APP_ID || "",
    accessKey: process.env.RAKUTEN_ACCESS_KEY || "",
    format: "json",
    formatVersion: "2",
    hotelNo: String(config.hotelNo),
    checkinDate: stay.checkin,
    checkoutDate: stay.checkout,
    adultNum: String(config.adultNum),
    roomNum: String(config.roomNum),
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

const matchesTarget = (room) => {
  const text = `${room.roomName || ""} ${room.planName || ""}`;
  return config.roomKeywords.some((k) => text.includes(k));
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
  const stays = buildStays();
  if (stays.length === 0) {
    console.log("監視期間が終了しています");
    return;
  }

  const prev = loadState();
  const nowAvailable = {};
  const errors = [];

  for (const stay of stays) {
    try {
      const json = await fetchVacancy(stay);
      const rooms = json ? extractRooms(json).filter(matchesTarget) : [];
      const label = stay.checkout === addDays(stay.checkin, 1)
        ? `${mdLabel(stay.checkin)}泊`
        : `${mdLabel(stay.checkin)}〜${mdLabel(stay.checkout)}連泊`;
      console.log(`${label}: ${rooms.length ? rooms.map((r) => r.roomName).join(" / ") : "空きなし"}`);
      for (const r of rooms) {
        const key = `${stay.checkin}_${stay.checkout}_${r.planId || ""}_${r.roomClass || r.roomName}`;
        nowAvailable[key] = {
          label,
          roomName: r.roomName,
          planName: r.planName,
          total: r.dailyCharge.total,
          url: r.reserveUrl,
        };
      }
    } catch (e) {
      errors.push(`${stay.checkin}: ${e.message}`);
      console.error(`${stay.checkin}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // APIへの連続アクセスを避ける
  }

  // 前回なかった空きだけ通知する
  const fresh = Object.entries(nowAvailable).filter(([k]) => !prev.available[k]);
  if (fresh.length) {
    const lines = fresh.map(([, v]) =>
      `・${v.label} ${v.roomName}${v.total ? `(1泊目 ${Number(v.total).toLocaleString()}円)` : ""}`
    );
    const msg = [
      ...lines,
      "",
      "楽天で空きが出ました。公式でも空いている可能性があるので、公式サイトもすぐ確認してください。",
      `公式: ${config.officialSearchUrl}`,
    ].join("\n");
    await notify(`${config.hotelLabel} 空きあり!`, msg, fresh[0][1].url);
  }

  // 全リクエストが失敗した時だけ1回通知(連続で通知しない)
  const allFailed = errors.length === stays.length;
  if (allFailed && !prev.errorNotified) {
    await notify(`${config.hotelLabel} 監視エラー`, errors.join("\n"));
  }

  const next = {
    // エラーになった日は前回の状態を引き継いで、復旧時の重複通知を防ぐ
    available: allFailed ? prev.available : { ...pickErrored(prev.available, errors), ...nowAvailable },
    errorNotified: allFailed ? true : false,
    checkedAt: new Date().toISOString(),
  };
  if (!DRY && !FIXTURE) fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
}

// 一部の日だけエラーの場合、その日の前回状態は残す
function pickErrored(prevAvailable, errors) {
  const erroredDates = new Set(errors.map((e) => e.split(":")[0]));
  return Object.fromEntries(Object.entries(prevAvailable).filter(([k]) => erroredDates.has(k.split("_")[0])));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
