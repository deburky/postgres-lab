// Headless recording of the city: Playwright drives the installed Google Chrome on the real GPU
// (ANGLE/Metal), and Chrome's own screencast hands over every rendered frame as a lossless PNG.
// The frames are stitched with ffmpeg into out/city.mp4 (H.264, 30 fps) and out/city.gif.
//
//   npx vite preview --port 4173 &      # the built bundle; the app must be up on :8000
//   node record.mjs [seconds]              # paper palette; CITY_THEME=neon for the night city (out/city-neon.*)
//   CITY_PAGE=queue node record.mjs 10     # the job queue page instead (out/queue.*); CITY_PRESET=retry picks a preset
import { chromium } from "playwright";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const seconds = Number(process.argv[2] ?? 9);
const theme = ["neon", "dark"].includes(process.env.CITY_THEME ?? "") ? "neon" : "paper"; // CITY_THEME=neon records the neon palette
const queue = process.env.CITY_PAGE === "queue";
const preset = process.env.CITY_PRESET ?? "skip"; // queue page only: skip, notify, limit, retry, priority
const url = process.env.CITY_URL ?? `http://localhost:4173/${queue ? "queue.html" : ""}?theme=${theme}`;
const size = { width: 1920, height: 1080 };
const out = "../out", frames = `${out}/frames`;
const name = queue ? (preset === "skip" ? "queue" : `queue-${preset}`) : "city";
const clip = theme === "neon" ? `${name}-neon` : name;
const LEAD = 0.3; // seconds of the finished "asking…" state kept before the run starts

const browser = await chromium.launch({
  headless: process.env.CITY_HEADLESS !== "0",
  channel: process.env.CITY_BROWSER ?? "chrome", // the installed Google Chrome; no Playwright download needed
  // headless on the real GPU through ANGLE/Metal (60 fps on an M2); CITY_GL=swiftshader is the software fallback
  args: process.env.CITY_GL === "swiftshader"
    ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    : ["--use-gl=angle", "--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on("console", m => { if (m.type() === "error") console.error("page:", m.text()); });

await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
const cdp = await context.newCDPSession(page);
const got = []; // { t: epoch seconds, file }
const writes = [];
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  const file = `${frames}/f${String(got.length).padStart(5, "0")}.png`;
  got.push({ t: metadata.timestamp, file });
  writes.push(writeFile(file, Buffer.from(data, "base64")));
  void cdp.send("Page.screencastFrameAck", { sessionId });
});
await cdp.send("Page.startScreencast", { format: "png", maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });

await page.goto(url, { waitUntil: "networkidle" });
if (queue) {
  // the page opens on the SKIP LOCKED run; wait for it, then start the preset asked for
  await page.waitForFunction(() => document.getElementById("counts")?.textContent?.includes("wall"), null, { timeout: 60_000 });
  if (preset !== "skip") {
    await page.click(`[data-preset=${preset}]`);
    await page.waitForFunction(() => !document.getElementById("run-btn")?.hasAttribute("disabled"), null, { timeout: 60_000 });
  } else {
    await page.click("#replay-btn"); // from the start, now that the recording is running
  }
} else {
  await page.waitForFunction(() => document.getElementById("times")?.textContent?.includes("ms"), null, { timeout: 60_000 });
}
const start = Date.now() / 1000 - LEAD;
await page.waitForTimeout(seconds * 1000);
await cdp.send("Page.stopScreencast");
await Promise.all(writes);
await browser.close();

const kept = got.filter(f => f.t >= start);
console.log(`${kept.length} frames over ${seconds} s (${(kept.length / seconds).toFixed(1)} fps)`);
// a concat list with the real inter-frame durations; ffmpeg resamples it to a steady 30 fps
const list = ["ffconcat version 1.0"];
kept.forEach((f, i) => {
  const next = kept[i + 1]?.t ?? f.t + 1 / 30;
  list.push(`file '${f.file.replace(`${out}/`, "")}'`, `duration ${(next - f.t).toFixed(5)}`);
});
await writeFile(`${out}/frames.txt`, list.join("\n") + "\n");
const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { cwd: out, stdio: "inherit" });
ff("-f", "concat", "-safe", "0", "-i", "frames.txt", "-vf", "fps=30,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
   "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-movflags", "+faststart", `${clip}.mp4`);
ff("-f", "concat", "-safe", "0", "-i", "frames.txt", "-vf", "fps=20,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=5", `${clip}.gif`);
await rm(frames, { recursive: true, force: true });
await rm(`${out}/frames.txt`, { force: true });
console.log(`wrote out/${clip}.mp4 and out/${clip}.gif`);
