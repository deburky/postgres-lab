// Both scenes need WebGL. When the browser will not create a context (hardware acceleration off, a
// crashed GPU process, too little memory), three.js throws before the page has drawn anything, and
// the reader sees empty panels. This check runs first and says what happened instead.

function webglAvailable(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    // hand the probe's context back straight away; browsers cap how many a page may hold
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/** Stops the page with a visible note when WebGL is unavailable. */
export function requireWebGL(): void {
  if (webglAvailable()) return;
  const note = document.createElement("div");
  note.className = "no-webgl";
  note.innerHTML = `
    <p class="eyebrow">No WebGL</p>
    <p>This scene draws with WebGL, and the browser refused to create a WebGL context.</p>
    <p>Chrome does this when hardware acceleration is off, or after its GPU process has crashed,
    which low memory can cause. Restarting the browser usually brings it back; <code>chrome://gpu</code>
    shows the current state.</p>`;
  document.body.append(note);
  throw new Error("WebGL is unavailable, so the scene was not started");
}
