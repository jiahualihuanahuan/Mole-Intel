// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

function dataDir() {
  return process.env.MOLE_DATA || path.join(process.cwd(), "data");
}

export function chinesePath() {
  return path.join(dataDir(), "chinese.jsonl");
}

function statusPath() {
  return path.join(dataDir(), "chinese-status.json");
}

export function appendChinese(row) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(chinesePath(), `${JSON.stringify(row)}\n`);
}

export function loadChinese(ticker) {
  const sections = {};
  let text = "";
  try {
    text = fs.readFileSync(chinesePath(), "utf8");
  } catch {
    return sections;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.ticker === ticker && row.section && row.zh) sections[row.section] = row.zh;
    } catch {
      // A torn line is skipped. The next section still gets its own line.
    }
  }
  return sections;
}

export function setChineseCurrent(ticker, section) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(statusPath(), "utf8"));
  } catch {
    all = {};
  }
  if (section) all[ticker] = section;
  else delete all[ticker];
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(statusPath(), JSON.stringify(all));
}

export function chineseCurrent(ticker) {
  try {
    const all = JSON.parse(fs.readFileSync(statusPath(), "utf8"));
    return typeof all[ticker] === "string" ? all[ticker] : "";
  } catch {
    return "";
  }
}
