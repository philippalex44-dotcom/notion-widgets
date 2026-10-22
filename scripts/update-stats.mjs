// Holt alle Trades aus Notion, berechnet Kennzahlen und legt sie
// verschlüsselt (AES-256-GCM) in stats.enc.json ab.
// Nur wer den Schlüssel kennt (steht im #-Teil der Embed-URL), kann sie lesen.
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const NOTION_KEY = process.env.NOTION_KEY;
const STATS_KEY = Buffer.from(process.env.STATS_KEY, "base64url");
const DB = "40100f59-b6c5-815f-ac38-eb8a16120e85";
const TZ = "Europe/Berlin";

async function queryAll() {
  const rows = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    const j = await res.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}

const num = (p) => (p?.type === "formula" ? p.formula.number : p?.number) ?? null;
const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD

const now = new Date();
const today = ymd(now);
const monthPrefix = today.slice(0, 7);
// Montag dieser Woche (Berlin)
const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
const monday = ymd(new Date(new Date(today + "T12:00:00Z").getTime() - dow * 86400000));

const trades = (await queryAll())
  .filter((p) => !p.in_trash && !p.archived)
  .map((p) => ({
    date: p.properties["Datum"]?.date?.start?.slice(0, 10) ?? null,
    exit: num(p.properties["Ausstieg"]),
    pnl: num(p.properties["P&L"]) ?? 0,
    r: num(p.properties["R-Multiple"]) ?? 0,
  }));

const closed = trades.filter((t) => t.exit !== null);
const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
const wins = closed.filter((t) => t.pnl > 0).length;

const stats = {
  total: sum(closed),
  month: sum(closed.filter((t) => t.date?.startsWith(monthPrefix))),
  week: sum(closed.filter((t) => t.date && t.date >= monday && t.date <= today)),
  today: sum(closed.filter((t) => t.date === today)),
  winRate: closed.length ? (wins / closed.length) * 100 : null,
  avgR: closed.length ? closed.reduce((s, t) => s + t.r, 0) / closed.length : null,
  trades: trades.length,
  open: trades.length - closed.length,
  date: today,
};

// Nur neu schreiben, wenn sich etwas geändert hat (verhindert unnötige Commits)
const fingerprint = createHmac("sha256", STATS_KEY).update(JSON.stringify(stats)).digest("hex");
const file = "stats.enc.json";
if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).fp === fingerprint) {
  console.log("unverändert");
  process.exit(0);
}

const iv = randomBytes(12);
const c = createCipheriv("aes-256-gcm", STATS_KEY, iv);
const ct = Buffer.concat([
  c.update(JSON.stringify({ ...stats, updated: now.toISOString() }), "utf8"),
  c.final(),
  c.getAuthTag(),
]);
writeFileSync(file, JSON.stringify({ fp: fingerprint, iv: iv.toString("base64"), ct: ct.toString("base64") }));
console.log("aktualisiert");
