// Records the API responses the two pages ask for, for the static build (src/replay.ts) to replay:
// public/traces/field.json, city-sync.json, city-async.json and queue-<preset>.json for every
// preset. The pages make the requests themselves, so the recorded runs are exactly what Ask and
// each preset button would get.
//
//   npx vite preview --port 4173 &      # the normal build; the app must be up on :8000 with the docs ingested
//   node save-traces.mjs
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.CITY_URL ?? "http://localhost:4173/";
const OUT = "public/traces";
const PRESETS = ["skip", "notify", "limit", "retry", "priority"];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.CITY_BROWSER ?? "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

async function save(name, response) {
  const body = await response.text();
  await writeFile(`${OUT}/${name}.json`, body);
  console.log(`${name}.json  ${(body.length / 1024).toFixed(0)} KB`);
}

const isTrace = path => r => new URL(r.url()).pathname === path && r.request().method() === (path === "/field" ? "GET" : "POST");

// the city: the field, then the sync and async runs of the default questions
const field = page.waitForResponse(isTrace("/field"), { timeout: 60_000 });
const sync = page.waitForResponse(r => isTrace("/trace")(r) && r.request().postDataJSON().mode === "sync", { timeout: 120_000 });
const async_ = page.waitForResponse(r => isTrace("/trace")(r) && r.request().postDataJSON().mode === "async", { timeout: 120_000 });
await page.goto(BASE);
await save("field", await field);
await save("city-sync", await sync);
await save("city-async", await async_);

// the queue: the page opens on SKIP LOCKED, then each other preset in turn
const first = page.waitForResponse(isTrace("/queue/trace"), { timeout: 120_000 });
await page.goto(`${BASE}queue.html`);
await save("queue-skip", await first);
for (const preset of PRESETS.slice(1)) {
  const next = page.waitForResponse(isTrace("/queue/trace"), { timeout: 120_000 });
  await page.click(`[data-preset=${preset}]`);
  await save(`queue-${preset}`, await next);
}

await browser.close();
