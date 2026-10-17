// The elephant crew: cartoon elephants (our own character, not the PostgreSQL logo) dressed for
// the jobs in the book, drawn in ink with sticky-note fills. Coordinates are points with y up;
// every character stands on (cx, base) and is about 340 pt tall.
var doc = app.activeDocument;
function col(h){ var c = new RGBColor(); c.red = parseInt(h.substr(0,2),16); c.green = parseInt(h.substr(2,2),16); c.blue = parseInt(h.substr(4,2),16); return c; }
var INK = col("1E1E1E"), WHITE = col("FFFFFF"), WASH = col("EFEFEC"), STEEL = col("D9D9D4");
var SKIN = col("BFD7EA"), EAR = col("F6C9C0");
var YEL = col("FFD166"), LIME = col("C7EA6B"), SKY = col("9FD3F5"), VIO = col("CBB8FF"), PEACH = col("FFB4A2"), MINT = col("A8E6CF"), KRAFT = col("E8C79A");
var MONO = app.textFonts.getByName("JetBrainsMono-Bold");
function ink(p, fill, w){ if (fill){ p.filled = true; p.fillColor = fill; } else p.filled = false; p.stroked = true; p.strokeColor = INK; p.strokeWidth = w || 2; p.strokeJoin = StrokeJoin.ROUNDENDJOIN; p.strokeCap = StrokeCap.ROUNDENDCAP; return p; }
function ell(cx, cy, w, h, fill, rot){ var e = ink(doc.pathItems.ellipse(cy + h/2, cx - w/2, w, h), fill); if (rot) e.rotate(rot); return e; }
function rrect(x, top, w, h, r, fill){ return ink(doc.pathItems.roundedRectangle(top, x, w, h, r, r), fill); }
function poly(pts, fill){ var p = doc.pathItems.add(); p.setEntirePath(pts); p.closed = true; return ink(p, fill); }
function line(pts, w){ var p = doc.pathItems.add(); p.setEntirePath(pts); p.closed = false; return ink(p, null, w); }
// a smooth path through [x, y, hx, hy] points, (hx, hy) being the handle offset on both sides
function curve(pts, fill, closed){
  var p = doc.pathItems.add();
  for (var i = 0; i < pts.length; i++){
    var q = p.pathPoints.add(), a = pts[i], hx = a[2] || 0, hy = a[3] || 0;
    q.anchor = [a[0], a[1]]; q.leftDirection = [a[0] - hx, a[1] - hy]; q.rightDirection = [a[0] + hx, a[1] + hy];
  }
  p.closed = closed !== false;
  return ink(p, closed === false ? null : fill);
}
function wtext(s, size, x, y){ var t = doc.textFrames.add(); t.contents = s; var a = t.textRange.characterAttributes; a.textFont = MONO; a.size = size; a.fillColor = INK; t.position = [x - t.width/2, y]; return t; }
// an isometric cube of data, as the jobs and rows are drawn elsewhere in the book
function cube(cx, cy, s, top){
  var c = 0.866 * s, h = 0.5 * s;
  poly([[cx - c, cy + h], [cx, cy], [cx, cy - s], [cx - c, cy - s + h]], WHITE);
  poly([[cx, cy], [cx + c, cy + h], [cx + c, cy - s + h], [cx, cy - s]], WASH);
  poly([[cx - c, cy + h], [cx, cy + s], [cx + c, cy + h], [cx, cy]], top);
}

// -------------------------------------------------------------------------------
// The shared elephant: legs, body in its outfit, arms in a pose, head
// -------------------------------------------------------------------------------
// set by placed() for one character: where the eyes look, and how far the walking foot is lifted
var LOOK = null, STRIDE = 0, TURN = 0;
function legs(cx, base, trousers){
  var st = STRIDE;
  rrect(cx - 44, base + 62, 34, 56, 14, trousers || SKIN); rrect(cx + 10 + st * 0.5, base + 62 + st, 34, 56, 14, trousers || SKIN);
  ell(cx - 27, base + 8, 46, 20, SKIN); ell(cx + 27 + st * 0.8, base + 8 + st, 46, 20, SKIN);
}
// the body is a 150 pt circle; an outfit draws inside it through a clipping mask
function body(cx, base, fill, outfit){
  ell(cx, base + 120, 150, 150, fill);
  if (outfit){
    var g = doc.groupItems.add();
    var mask = doc.pathItems.ellipse(base + 195, cx - 75, 150, 150);
    var parts = outfit(cx + 16 * TURN, base);
    for (var i = 0; i < parts.length; i++) parts[i].move(g, ElementPlacement.PLACEATEND);
    mask.move(g, ElementPlacement.PLACEATBEGINNING); mask.clipping = true; g.clipped = true;
  }
  ink(doc.pathItems.ellipse(base + 195, cx - 75, 150, 150), null);
}
// an arm from the shoulder; side -1 is the reader's left. "down" hangs, "out" holds something to
// the side, "front" wraps round something held in front, "up" lifts a hand to head height
function arm(cx, base, side, pose, sleeve){
  var s = side, f = sleeve || SKIN, x0 = cx + s * 60, y0 = base + 170;
  if (pose == "down") curve([[x0, y0, s * 10, -6], [cx + s * 84, base + 110, s * 2, -12], [cx + s * 70, base + 100, -s * 8, 0], [cx + s * 56, base + 145, -s * 2, 10]], f);
  if (pose == "out") curve([[x0, y0, s * 10, -6], [cx + s * 98, base + 132, s * 4, -10], [cx + s * 86, base + 120, -s * 8, 0], [cx + s * 58, base + 148, -s * 6, 8]], f);
  if (pose == "front") curve([[x0, y0, s * 12, -4], [cx + s * 66, base + 128, -s * 2, -12], [cx + s * 46, base + 120, -s * 8, 0], [cx + s * 50, base + 150, s * 2, 8]], f);
  if (pose == "up") curve([[x0, y0, s * 14, 2], [cx + s * 98, base + 222, s * 2, 12], [cx + s * 84, base + 226, -s * 6, 0], [cx + s * 58, base + 152, -s * 4, -6]], f);
}
var HAND = { out: [98, 128], front: [60, 124], up: [94, 226], down: [80, 104] };
function hand(cx, base, side, pose){ var h = HAND[pose]; return [cx + side * h[0], base + h[1]]; }

// big ears, a round face and a short trunk. TURN (0 to 1) turns the face three-quarters to the
// reader's right: the features slide that way, the far eye narrows and the far ear tucks behind
function head(cx, base, look){
  var cy = base + 262, t = TURN;
  ell(cx - 70 + 6 * t, cy + 5, 92, 118, SKIN, 12); ell(cx - 68 + 6 * t, cy + 3, 56, 80, EAR, 12);
  ell(cx + 70 - 26 * t, cy + 5, 92 - 34 * t, 118 - 12 * t, SKIN, -12); ell(cx + 68 - 26 * t, cy + 3, 56 - 26 * t, 80 - 12 * t, EAR, -12);
  ell(cx + 4 * t, cy, 128 - 8 * t, 118, SKIN);
  var o = 22 * t;
  curve([[cx - 14 + o, cy - 2, 0, -12], [cx - 16 + o, cy - 50, 2, -12], [cx + 4 + o, cy - 74, 14, 0], [cx + 26 + o, cy - 60, 2, 10],
         [cx + 16 + o, cy - 56, -4, -2], [cx + 4 + o, cy - 58, 2, 4], [cx + 6 + o, cy - 34, 0, 14], [cx + 14 + o, cy - 2, 0, 12]], SKIN);
  line([[cx - 8 + o, cy - 40], [cx + 6 + o, cy - 40]], 1.4); line([[cx - 8 + o, cy - 50], [cx + 6 + o, cy - 50]], 1.4);
  var dx = (LOOK !== null ? LOOK : (look || 0)) + 3 * t, le = cx - 26 + 16 * t, re = cx + 26 + 14 * t, rw = 22 - 8 * t;
  ell(le, cy + 18, 22, 26, WHITE); ell(re, cy + 18, rw, 26, WHITE);
  ell(le + dx, cy + 15, 9, 11, INK); ell(re + dx * 0.7, cy + 15, 9 - 3 * t, 11, INK);
  curve([[le - 10, cy + 38, 5, 4], [le + 10, cy + 40, 5, -2]], null, false); curve([[re - 10 * (1 - 0.3 * t), cy + 40, 5, 2], [re + 10 * (1 - 0.3 * t), cy + 38, 5, -4]], null, false);
  var ch = ell(cx - 42 + 18 * t, cy - 8, 20, 12, PEACH); ch.stroked = false; ch = ell(cx + 42 + 4 * t, cy - 8, 20 - 8 * t, 12, PEACH); ch.stroked = false;
  curve([[cx - 24 + o, cy - 26, -4, -6], [cx - 30 + o, cy - 40, 0, -4], [cx - 22 + o, cy - 30, 2, 4]], WHITE);
}

// -------------------------------------------------------------------------------
// Hats and outfits
// -------------------------------------------------------------------------------
function cap(cx, base, fill){
  curve([[cx - 56, base + 300, 4, 26], [cx, base + 336, 32, 0], [cx + 56, base + 300, 4, -26]], fill);
  rrect(cx + 20, base + 304, 62, 8, 4, fill);
}
function hardHat(cx, base){
  curve([[cx - 52, base + 302, 2, 30], [cx, base + 344, 32, 0], [cx + 52, base + 302, 2, -30]], YEL);
  rrect(cx - 70, base + 306, 140, 10, 5, YEL); rrect(cx - 8, base + 343, 16, 40, 6, YEL);
}
function glasses(cx, base){
  var cy = base + 280, t = TURN, le = cx - 26 + 16 * t, re = cx + 26 + 14 * t;
  ell(le, cy, 34, 30, null).strokeWidth = 2.5; ell(re, cy, 34 - 10 * t, 30, null).strokeWidth = 2.5; line([[le + 17, cy + 2], [re - 17 + 5 * t, cy + 2]], 2.5);
}
function overalls(cx, base){
  return [ink(doc.pathItems.rectangle(base + 118, cx - 80, 160, 80), YEL), ink(doc.pathItems.roundedRectangle(base + 170, cx - 38, 76, 60, 8, 8), YEL)];
}
function overallsDetail(cx, base){
  rrect(cx - 18, base + 150, 36, 24, 5, null);
  line([[cx - 34, base + 168], [cx - 52, base + 190]], 6); line([[cx + 34, base + 168], [cx + 52, base + 190]], 6);
  ell(cx - 32, base + 164, 9, 9, WHITE); ell(cx + 32, base + 164, 9, 9, WHITE);
}
function labCoat(cx, base){
  return [ink(doc.pathItems.rectangle(base + 200, cx - 18, 36, 160), SKY),
          poly([[cx - 18, base + 200], [cx - 2, base + 150], [cx - 34, base + 190]], WHITE), poly([[cx + 18, base + 200], [cx + 2, base + 150], [cx + 34, base + 190]], WHITE)];
}
function hoodie(cx, base){ return [ink(doc.pathItems.roundedRectangle(base + 110, cx - 40, 80, 40, 10, 10), LIME)]; }
function polo(cx, base){
  return [poly([[cx - 26, base + 196], [cx, base + 176], [cx - 6, base + 162], [cx - 30, base + 186]], PEACH),
          poly([[cx + 26, base + 196], [cx, base + 176], [cx + 6, base + 162], [cx + 30, base + 186]], PEACH)];
}
function vest(cx, base){
  return [poly([[cx - 80, base + 40], [cx - 80, base + 200], [cx - 24, base + 200], [cx, base + 140], [cx + 24, base + 200], [cx + 80, base + 200], [cx + 80, base + 40]], VIO),
          poly([[cx - 7, base + 196], [cx + 7, base + 196], [cx + 10, base + 160], [cx, base + 148], [cx - 10, base + 160]], PEACH)];
}
function hiVis(cx, base){
  return [poly([[cx - 80, base + 40], [cx - 80, base + 200], [cx - 30, base + 200], [cx - 14, base + 120], [cx + 14, base + 120], [cx + 30, base + 200], [cx + 80, base + 200], [cx + 80, base + 40]], YEL),
          ink(doc.pathItems.rectangle(base + 100, cx - 80, 160, 12), LIME)];
}

// -------------------------------------------------------------------------------
// Props
// -------------------------------------------------------------------------------
function wrench(x, y, angle){
  var g = doc.groupItems.add();
  rrect(x - 50, y + 5, 54, 10, 5, STEEL).move(g, ElementPlacement.PLACEATEND);
  ell(x - 58, y, 22, 22, STEEL).move(g, ElementPlacement.PLACEATEND);
  var notch = doc.pathItems.rectangle(y + 4, x - 72, 14, 8); notch.filled = true; notch.fillColor = WHITE; notch.stroked = false; notch.move(g, ElementPlacement.PLACEATEND);
  g.rotate(angle || 0);
}
// held at (x, y), the lens up and out to the reader's right
function magnifier(x, y){
  line([[x, y], [x + 22, y + 24]], 8);
  ell(x + 40, y + 44, 48, 48, col("E4F3FC")).strokeWidth = 4;
}
function laptop(cx, y){
  rrect(cx - 52, y + 62, 104, 66, 6, WASH);
  rrect(cx - 44, y + 54, 88, 50, 3, WHITE);
  line([[cx - 34, y + 42], [cx - 4, y + 42]], 2); line([[cx - 34, y + 32], [cx + 18, y + 32]], 2); line([[cx - 34, y + 22], [cx + 4, y + 22]], 2);
  poly([[cx - 60, y - 4], [cx + 60, y - 4], [cx + 52, y + 4], [cx - 52, y + 4]], STEEL);
}
function clipboard(x, y){
  rrect(x - 30, y + 46, 60, 80, 6, KRAFT); rrect(x - 24, y + 38, 48, 66, 2, WHITE);
  rrect(x - 12, y + 52, 24, 12, 4, STEEL);
  for (var i = 0; i < 4; i++) line([[x - 16, y + 24 - i * 14], [x + (i == 3 ? 4 : 16), y + 24 - i * 14]], 2);
  line([[x - 16, y + 24], [x - 12, y + 20], [x - 8, y + 28]], 2);
}

// -------------------------------------------------------------------------------
// The crew
// -------------------------------------------------------------------------------
var CREW = {
  // Postgres from Python: a developer in a hoodie with a laptop
  developer: function(cx, base){
    legs(cx, base, SKY); body(cx, base, LIME, hoodie);
    var hc = cx + 16 * TURN; line([[hc - 14, base + 188], [hc - 16, base + 160]], 2); line([[hc + 14, base + 188], [hc + 16, base + 160]], 2);
    arm(cx, base, -1, "front", LIME); arm(cx, base, 1, "front", LIME);
    laptop(cx, base + 96);
    head(cx, base, 0);
  },
  // Search: a researcher in a lab coat, peering through a magnifying glass
  researcher: function(cx, base){
    legs(cx, base, STEEL); body(cx, base, WHITE, labCoat);
    arm(cx, base, -1, "down", WHITE); arm(cx, base, 1, "up", WHITE);
    head(cx, base, 3); glasses(cx, base);
    var h = hand(cx, base, 1, "up"); magnifier(h[0] - 2, h[1] - 4);
  },
  // Queues: a worker in overalls carrying a job
  queueWorker: function(cx, base){
    legs(cx, base); body(cx, base, SKIN, overalls); overallsDetail(cx + 16 * TURN, base);
    var h = hand(cx, base, 1, "out"); cube(h[0] + 2, h[1] + 4, 40, PEACH);
    arm(cx, base, -1, "down"); arm(cx, base, 1, "out");
    head(cx, base, 1); cap(cx, base, SKY);
  },
  // Moving data: a courier in a polo shirt with a stack of cubes
  courier: function(cx, base){
    legs(cx, base, KRAFT); body(cx, base, PEACH, polo);
    ell(cx + 16 * TURN, base + 150, 7, 7, WHITE); ell(cx + 16 * TURN, base + 130, 7, 7, WHITE);
    var h = hand(cx, base, 1, "out");
    cube(h[0] + 6, h[1] + 2, 32, YEL); cube(h[0] + 6, h[1] + 34, 32, LIME); cube(h[0] + 6, h[1] + 66, 32, SKY);
    arm(cx, base, -1, "down", PEACH); arm(cx, base, 1, "out", PEACH);
    head(cx, base, -2); cap(cx, base, PEACH);
  },
  // Access: a clerk in a vest and tie, ticking a clipboard
  clerk: function(cx, base){
    legs(cx, base, VIO); body(cx, base, WHITE, vest);
    var h = hand(cx, base, -1, "front"); clipboard(cx - 34, base + 90);
    arm(cx, base, -1, "front", WHITE); arm(cx, base, 1, "down", WHITE);
    head(cx, base, -2);
  },
  // Operations: an engineer in a hard hat and hi-vis vest with a wrench
  engineer: function(cx, base){
    legs(cx, base, SKY); body(cx, base, SKY, hiVis);
    arm(cx, base, -1, "out", SKY); arm(cx, base, 1, "down", SKY);
    var h = hand(cx, base, -1, "out"); wrench(h[0] + 6, h[1] - 4, -30);
    head(cx, base, -3); hardHat(cx, base);
  }
};

// a Postgres database as a tall cylinder, the thing the crew looks after
function database(cx, base, w, h){
  var a = w / 2, b = w * 0.14, K = 0.5523;
  var p = doc.pathItems.add();
  function pt(x, y, l, r){ var q = p.pathPoints.add(); q.anchor = [x, y]; q.leftDirection = l; q.rightDirection = r; }
  pt(cx - a, base + h, [cx - a, base + h], [cx - a, base + h]);
  pt(cx - a, base, [cx - a, base], [cx - a, base - K * b]);
  pt(cx, base - b, [cx - K * a, base - b], [cx + K * a, base - b]);
  pt(cx + a, base, [cx + a, base - K * b], [cx + a, base]);
  pt(cx + a, base + h, [cx + a, base + h], [cx + a, base + h]);
  p.closed = true; ink(p, WHITE, 2.5);
  for (var i = 1; i <= 2; i++){
    var y = base + h * i / 3, q = doc.pathItems.add();
    var a1 = q.pathPoints.add(); a1.anchor = [cx - a, y]; a1.leftDirection = [cx - a, y]; a1.rightDirection = [cx - a, y - K * b];
    var a2 = q.pathPoints.add(); a2.anchor = [cx, y - b]; a2.leftDirection = [cx - K * a, y - b]; a2.rightDirection = [cx + K * a, y - b];
    var a3 = q.pathPoints.add(); a3.anchor = [cx + a, y]; a3.leftDirection = [cx + a, y - K * b]; a3.rightDirection = [cx + a, y];
    q.closed = false; ink(q, null, 2.5);
  }
  ink(doc.pathItems.ellipse(base + h + b, cx - a, w, 2 * b), SKY, 2.5);
  wtext("Postgres", 26, cx, base + h * 0.58);
}


// one character on its own layer, grouped so it can lean (degrees, positive leans to the reader's
// left), face the other way (flip) and look somewhere (pupil offset, already in the final facing)
function placed(name, cx, base, lean, flip, look, stride){
  var layer = doc.layers.add(); layer.name = name;
  LOOK = look === undefined ? null : (flip ? -look : look); STRIDE = stride || 0;
  CREW[name](cx, base);
  LOOK = null; STRIDE = 0;
  doc.selection = null; layer.hasSelectedArtwork = true; app.executeMenuCommand("group");
  var g = doc.selection[0];
  if (flip) g.resize(-100, 100);
  if (lean) g.rotate(lean);
  doc.selection = null;
  return g;
}
function motion(x, y, dir){ for (var i = 0; i < 3; i++) line([[x, y + i * 18], [x + dir * (34 - i * 8), y + i * 18]], 2); }
function sparks(x, y){
  var r = [[14, 10], [18, -4], [10, -16], [-2, 18]];
  for (var i = 0; i < r.length; i++) line([[x + r[i][0] * 0.5, y + r[i][1] * 0.5], [x + r[i][0] * 1.4, y + r[i][1] * 1.4]], 2);
}
function stool(cx, base, h){
  rrect(cx - 46, base + h, 92, 12, 4, KRAFT);
  line([[cx - 34, base + h - 12], [cx - 44, base]], 4); line([[cx + 34, base + h - 12], [cx + 44, base]], 4);
  line([[cx - 38, base + h * 0.45], [cx + 38, base + h * 0.45]], 3);
}

// more of the crew, for the moving parts of the scene
CREW.carrier = function(cx, base){
  legs(cx, base, KRAFT); body(cx, base, SKY);
  curve([[cx - 22, base + 194, 6, -12], [cx, base + 178, 12, 0], [cx + 22, base + 194, 6, 12]], null, false);
  cube(cx + 4, base + 146, 46, YEL);
  arm(cx, base, -1, "front", SKY); arm(cx, base, 1, "front", SKY);
  head(cx, base, 2); cap(cx, base, YEL);
};
CREW.mover = function(cx, base){
  var hx = cx + 98, hy = base + 128;
  line([[hx, hy + 6], [hx + 34, base + 12]], 5); line([[hx + 34, base + 12], [hx + 100, base + 12]], 5);
  cube(hx + 68, base + 50, 34, PEACH); cube(hx + 68, base + 86, 34, LIME);
  ell(hx + 34, base + 14, 26, 26, STEEL).strokeWidth = 3;
  legs(cx, base, SKY); body(cx, base, MINT, polo);
  arm(cx, base, -1, "front", MINT); arm(cx, base, 1, "out", MINT);
  head(cx, base, 3); cap(cx, base, MINT);
};
CREW.stacker = function(cx, base){
  legs(cx, base, VIO); body(cx, base, YEL);
  curve([[cx - 22, base + 194, 6, -12], [cx, base + 178, 12, 0], [cx + 22, base + 194, 6, 12]], null, false);
  var h = hand(cx, base, 1, "out"); cube(h[0] + 4, h[1] + 6, 40, SKY);
  arm(cx, base, -1, "down", YEL); arm(cx, base, 1, "out", YEL);
  head(cx, base, 3); cap(cx, base, LIME);
};
function belt(x0, x1, y){
  rrect(x0, y + 10, x1 - x0, 20, 10, STEEL);
  for (var x = x0 + 16; x < x1 - 8; x += 36) ell(x, y, 12, 12, WHITE);
  line([[x0 + 20, y - 10], [x0 + 10, y - 60]], 4); line([[x1 - 20, y - 10], [x1 - 10, y - 60]], 4);
}
function ramp(x0, y0, x1, y1){
  poly([[x0, y0], [x1, y1], [x1, y1 - 14], [x0 + 20, y0]], KRAFT);
  for (var t = 0.15; t < 0.95; t += 0.18) line([[x0 + (x1 - x0) * t, y0 + (y1 - y0) * t - 2], [x0 + (x1 - x0) * t + 8, y0 + (y1 - y0) * t - 12]], 2);
}
function pile(cx, base){
  var c = [[0, 0, YEL], [56, 0, LIME], [112, 0, PEACH], [28, 50, SKY], [84, 50, VIO], [56, 100, MINT]];
  for (var i = 0; i < c.length; i++) cube(cx - 56 + c[i][0], base + 54 + c[i][1], 32, c[i][2]);
}

// the banner: data arrives from the application, is queued, stored, inspected, maintained,
// moved out and stacked in the warehouse
function crewBanner(base){
  var main = doc.layers[doc.layers.length - 1];
  doc.activeLayer = main;
  line([[40, base], [2420, base]], 2);
  // the app side: a belt from the developer's laptop
  belt(270, 560, base + 70);
  cube(330, base + 112, 30, PEACH); cube(420, base + 112, 30, LIME); cube(505, base + 112, 30, VIO);
  // into the database up a ramp, through a hatch on top
  ramp(760, base, 1010, base + 300);
  database(1120, base + 10, 240, 300);
  ell(1120, base + 312, 96, 26, INK);
  // out of the database at the side, to the warehouse pile
  rrect(1236, base + 120, 40, 90, 8, WASH);
  stool(1360, base, 70);
  sparks(1250, base + 240);
  pile(1960, base);
  motion(820, base + 140, -1); motion(1600, base + 160, -1);
  placed("developer", 150, base, 3, false, 2);
  placed("queueWorker", 650, base, 16, true, -4);
  placed("carrier", 890, base + 118, -18, false, 3, 12);
  placed("engineer", 1360, base + 82, 10, false, -4);
  placed("mover", 1660, base, -12, false, 3, 14);
  placed("stacker", 2150, base, 14, true, -4);
  placed("clerk", 2360, base, 6, true, -3);
  var r = placed("researcher", 1120, base + 318, -6, false, 3);
  r.resize(62, 62);
}

// needs iso.jsx loaded first (P, items)
// one crew member standing on the ground point (x, y, z), drawn in its turn in the painter's
// queue: scale sc, turned three-quarters (to the reader's right, or left with flip); lean is unused
// because the crew stays upright; look = pupil offset
function sprite(name, x, y, z, sc, lean, flip, look, stride){
  items.push({k: x + y + 0.5, f: function(){
    var main = doc.activeLayer, tmp = doc.layers.add();
    var marker = doc.pathItems.rectangle(0.05, -0.05, 0.1, 0.1); marker.filled = false; marker.stroked = false;
    LOOK = look === undefined ? null : (flip ? -look : look); STRIDE = stride || 0; TURN = 1;
    CREW[name](0, 0);
    LOOK = null; STRIDE = 0; TURN = 0;
    doc.selection = null; tmp.hasSelectedArtwork = true; app.executeMenuCommand("group");
    var g = doc.selection[0]; doc.selection = null;
    g.resize((flip ? -1 : 1) * sc, sc, true, true, true, true, 55);
    var mb = marker.geometricBounds, at = P(x, y, z);
    g.translate(at[0] - (mb[0] + mb[2]) / 2, at[1] - (mb[1] + mb[3]) / 2);
    g.move(main, ElementPlacement.PLACEATBEGINNING);
    tmp.remove();
    doc.activeLayer = main;
  }});
}

