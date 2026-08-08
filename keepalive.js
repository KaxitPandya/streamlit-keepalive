/**
 * Streamlit Community Cloud keep-alive / auto-waker.
 *
 * Why a real browser is required:
 *   A plain GET to https://<app>.streamlit.app/ returns the Community Cloud
 *   dashboard SPA (a static React shell) with HTTP 200 whether the app is
 *   awake or asleep. It never touches the app container, so uptime-pinger
 *   style keep-alives register no traffic and cannot even detect sleep.
 *
 *   The real app is served in an iframe at  https://<app>.streamlit.app/~/+/
 *   and the sleep screen ("Zzzz / Yes, get this app back up!") is rendered by
 *   the outer SPA with data-testid="wakeup-button-viewer".
 *
 * So this script loads the page like a visitor, clicks the wake button when
 * present, and confirms the app actually rendered.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const APPS = JSON.parse(fs.readFileSync(path.join(__dirname, "apps.json"), "utf8"));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const NAV_TIMEOUT = 90_000;
const RESOLVE_TIMEOUT = 90_000; // wait for app-or-sleep-screen to appear
const WAKE_TIMEOUT = 300_000; // cold boot can take minutes
const DWELL_MS = 8_000; // stay connected so the session registers

const name = (url) => new URL(url).hostname.split(".")[0];

/** Cheap pre-check: this endpoint reaches the actual container, unlike the app root. */
async function healthCheck(url) {
  const origin = new URL(url).origin;
  const jar = new Map();
  let next = origin + "/";

  // Follow the auth-cookie handshake manually so cookies persist across hops.
  for (let hop = 0; hop < 12; hop++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(next, {
      redirect: "manual",
      headers: { "User-Agent": UA, ...(cookie && { Cookie: cookie }) },
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      v === "" ? jar.delete(k) : jar.set(k, v);
    }
    const loc = res.headers.get("location");
    if (!loc) break;
    next = new URL(loc, next).toString();
  }

  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  try {
    const res = await fetch(`${origin}/~/+/_stcore/health`, {
      headers: { "User-Agent": UA, Cookie: cookie },
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok && (await res.text()).trim() === "ok" ? "ok" : `http ${res.status}`;
  } catch (e) {
    return `unreachable (${e.message})`;
  }
}

/** The Streamlit app itself lives in the /~/+/ iframe. */
function appFrame(page) {
  return page.frames().find((f) => f.url().includes("/~/+/"));
}

async function appRendered(page) {
  const f = appFrame(page);
  if (!f) return false;
  return (await f.locator('[data-testid="stApp"], .stApp').count()) > 0;
}

async function visit(browser, url) {
  const log = [];
  const t0 = Date.now();
  const say = (m) => {
    const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`;
    log.push(line);
    console.log(`   ${line}`);
  };

  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  try {
    const health = await healthCheck(url);
    say(`health: ${health}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

    const wakeBtn = page.locator(
      '[data-testid="wakeup-button-viewer"], [data-testid="wakeup-button-owner"]'
    );

    // Race: either the app iframe renders, or the sleep screen appears.
    const deadline = Date.now() + RESOLVE_TIMEOUT;
    let state = "unresolved";
    while (Date.now() < deadline) {
      if (await wakeBtn.count()) {
        state = "asleep";
        break;
      }
      if (await appRendered(page)) {
        state = "awake";
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (state === "asleep") {
      say("ASLEEP — clicking wake button");
      await wakeBtn.first().click();

      const wakeDeadline = Date.now() + WAKE_TIMEOUT;
      while (Date.now() < wakeDeadline) {
        if (await appRendered(page)) {
          say("WOKEN — app rendered");
          await page.waitForTimeout(DWELL_MS);
          return { status: "WOKEN", log };
        }
        await page.waitForTimeout(2000);
      }
      say("wake timed out");
      return { status: "WAKE_TIMEOUT", log };
    }

    if (state === "awake") {
      say("AWAKE — app already rendered");
      await page.waitForTimeout(DWELL_MS); // dwell so the session counts as traffic
      return { status: "AWAKE", log };
    }

    say(`UNRESOLVED — title="${await page.title()}"`);
    return { status: "UNRESOLVED", log };
  } catch (e) {
    say(`ERROR: ${e.message.split("\n")[0]}`);
    return { status: "ERROR", log };
  } finally {
    await ctx.close().catch(() => {});
  }
}

(async () => {
  const browser = await chromium.launch();
  const results = {};

  for (const url of APPS) {
    console.log(`\n=== ${name(url)}`);
    results[url] = await visit(browser, url);
  }
  await browser.close();

  console.log("\n=== SUMMARY ===");
  for (const [url, r] of Object.entries(results)) {
    console.log(`${r.status.padEnd(13)} ${name(url)}`);
  }

  // GitHub Actions job summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const icon = { AWAKE: "✅", WOKEN: "🔄", WAKE_TIMEOUT: "⚠️", UNRESOLVED: "⚠️", ERROR: "❌" };
    const rows = Object.entries(results)
      .map(([url, r]) => `| ${icon[r.status] ?? ""} ${r.status} | [${name(url)}](${url}) |`)
      .join("\n");
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Streamlit keep-alive\n\n| Status | App |\n|---|---|\n${rows}\n`
    );
  }

  const bad = Object.values(results).filter((r) =>
    ["ERROR", "WAKE_TIMEOUT", "UNRESOLVED"].includes(r.status)
  );
  process.exit(bad.length ? 1 : 0);
})();
