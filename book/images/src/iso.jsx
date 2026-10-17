// Isometric ink-on-paper helpers for Illustrator 2020 (ExtendScript, ES3).
// S is points per world unit; OX, OY place world (0, 0, 0) on the artboard. Larger x runs down to
// the right, larger y down to the left, z is up. Draw ground objects through box/cyl/tree, then flush().
var S = 9, C = 0.8660254, OX = 700, OY = 740;
var doc = app.activeDocument;
function col(h){ var c = new RGBColor(); c.red = parseInt(h.substr(0,2),16); c.green = parseInt(h.substr(2,2),16); c.blue = parseInt(h.substr(4,2),16); return c; }
var INK = col("1E1E1E"), WHITE = col("FFFFFF"), WASH = col("EFEFEC"), MUTED = col("6F6F6F");
var YEL = col("FFD166"), LIME = col("C7EA6B"), SKY = col("9FD3F5"), VIO = col("CBB8FF"), PEACH = col("FFB4A2"), MINT = col("A8E6CF");
var MONO = app.textFonts.getByName("JetBrainsMono-Bold"), MONO_REG = app.textFonts.getByName("JetBrainsMono-Regular");
function P(x,y,z){ return [OX + (x - y)*C*S, OY - (x + y)*0.5*S + z*S]; }
function style(p, fill){ if (fill){ p.filled = true; p.fillColor = fill; } else p.filled = false; p.stroked = true; p.strokeColor = INK; p.strokeWidth = 1.5; p.strokeJoin = StrokeJoin.ROUNDENDJOIN; p.strokeCap = StrokeCap.ROUNDENDCAP; return p; }
function poly(pts, fill){ var p = doc.pathItems.add(); p.setEntirePath(pts); p.closed = true; return style(p, fill); }
function line(pts){ var p = doc.pathItems.add(); p.setEntirePath(pts); p.closed = false; return style(p, null); }
function drawBox(x,y,z,w,d,h,top){
  poly([P(x,y+d,z),P(x+w,y+d,z),P(x+w,y+d,z+h),P(x,y+d,z+h)], WHITE);
  poly([P(x+w,y,z),P(x+w,y+d,z),P(x+w,y+d,z+h),P(x+w,y,z+h)], WASH);
  poly([P(x,y,z+h),P(x+w,y,z+h),P(x+w,y+d,z+h),P(x,y+d,z+h)], top || WHITE);
}
function tile(x,y,w,d,fill,z){ z = z || 0; return poly([P(x,y,z),P(x+w,y,z),P(x+w,y+d,z),P(x,y+d,z)], fill); }
var K = 0.5523;
function arc(cx, yb, a, b, closedTop, yt, fill){
  var p = doc.pathItems.add();
  function pt(anchor, l, r){ var q = p.pathPoints.add(); q.anchor = anchor; q.leftDirection = l; q.rightDirection = r; q.pointType = PointType.CORNER; }
  if (closedTop) pt([cx - a, yt], [cx - a, yt], [cx - a, yt]);
  pt([cx - a, yb], [cx - a, yb], [cx - a, yb - K*b]);
  pt([cx, yb - b], [cx - K*a, yb - b], [cx + K*a, yb - b]);
  pt([cx + a, yb], [cx + a, yb - K*b], [cx + a, yb]);
  if (closedTop) pt([cx + a, yt], [cx + a, yt], [cx + a, yt]);
  p.closed = !!closedTop;
  return style(p, fill);
}
function drawCyl(cx, cy, z0, h, r, top, bands){
  var a = 1.2247*r*S, b = 0.7071*r*S;
  var t = P(cx, cy, z0 + h), bt = P(cx, cy, z0);
  arc(t[0], bt[1], a, b, true, t[1], WHITE);
  for (var i = 1; i <= bands; i++){ var yy = bt[1] + (t[1] - bt[1]) * i / (bands + 1); arc(t[0], yy, a, b, false); }
  style(doc.pathItems.ellipse(t[1] + b, t[0] - a, 2*a, 2*b), top);
}
function drawTree(x, y, crown){
  drawBox(x - 0.35, y - 0.35, 0, 0.7, 0.7, 1.6);
  var c = P(x, y, 1.6), r = 11;
  style(doc.pathItems.ellipse(c[1] + 2*r - 3, c[0] - r, 2*r, 2*r), crown);
}
// painter's queue: everything that stands on the ground, drawn back to front
var items = [];
function box(x,y,z,w,d,h,top){ items.push({k: x + w/2 + y + d/2 + z*0.01, f: function(){ drawBox(x,y,z,w,d,h,top); }}); }
function cyl(cx,cy,z0,h,r,top,bands){ items.push({k: cx + cy, f: function(){ drawCyl(cx,cy,z0,h,r,top,bands); }}); }
function tree(x,y,crown){ items.push({k: x + y, f: function(){ drawTree(x,y,crown); }}); }
function flush(){ items.sort(function(a, b){ return a.k - b.k; }); for (var i = 0; i < items.length; i++) items[i].f(); items = []; }
function text(s, font, size, color){ var tf = doc.textFrames.add(); tf.contents = s; var a = tf.textRange.characterAttributes; a.textFont = font; a.size = size; a.fillColor = color; return tf; }
// a label card; the leader leaves from side "l", "r", "t" or "b" and ends in a dot at (ax, ay)
function card(cx, top, title, sub, side, ax, ay){
  var t1 = text(title, MONO, 15, INK), t2 = text(sub, MONO_REG, 10.5, MUTED);
  var w = Math.max(t1.width, t2.width) + 28, h = 52, left = cx - w/2;
  var sx = side == "l" ? left : side == "r" ? left + w : cx, sy = side == "t" ? top : side == "b" ? top - h : top - h/2;
  line([[sx, sy], [ax, ay]]);
  style(doc.pathItems.ellipse(ay + 3.5, ax - 3.5, 7, 7), INK);
  style(doc.pathItems.roundedRectangle(top, left, w, h, 9, 9), WHITE);
  t1.zOrder(ZOrderMethod.BRINGTOFRONT); t2.zOrder(ZOrderMethod.BRINGTOFRONT);
  t1.position = [left + 14, top - 9]; t2.position = [left + 14, top - 31];
}
function clear(){ while (doc.pageItems.length) doc.pageItems[0].remove(); }
