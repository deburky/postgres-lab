// Boots each SQL lab in Chrome and clicks every example chip, printing the status and the start of
// the output, so a broken seed or example shows up as an error line. Run against `npm run preview`.
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://localhost:4173";
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1000, height: 900 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const idle = () => p.waitForFunction(() => !document.getElementById("run").disabled || /did not/.test(document.getElementById("status").textContent), null, { timeout: 90000 });
for (const lab of ["vectors", "jsonb", "pgmq", "graph"]) {
  const t0 = Date.now();
  await p.goto(`${base}/sql.html?lab=${lab}`);
  await idle();
  console.log(`\n== ${lab}: ${await p.textContent("#pg")} (page ${Date.now() - t0} ms)`);
  const n = await p.locator("#chips button").count();
  for (let i = 0; i < n; i++) {
    await p.locator("#chips button").nth(i).click();
    await p.waitForTimeout(50);
    await idle();
    const label = await p.locator("#chips button").nth(i).textContent();
    const text = (await p.textContent("#out")).replace(/\s+/g, " ").slice(0, 260);
    console.log(`- ${label} [${await p.textContent("#status")}] ${text}`);
  }
}
await b.close();
