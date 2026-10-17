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
function drawBox(x,y,z,w,d,h,top,left,right){
  poly([P(x,y+d,z),P(x+w,y+d,z),P(x+w,y+d,z+h),P(x,y+d,z+h)], left || WHITE);
  poly([P(x+w,y,z),P(x+w,y+d,z),P(x+w,y+d,z+h),P(x+w,y,z+h)], right || WASH);
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
function boxc(x,y,z,w,d,h,top,left,right,bias){ items.push({k: x + w/2 + y + d/2 + z*0.01 + (bias || 0), f: function(){ drawBox(x,y,z,w,d,h,top,left,right); }}); }
// an elephant built from boxes, facing +x ("x") or +y ("y"), s times the base size, with an
// optional cube of data on its back
var ELE_TOP = col("D6E6F2"), ELE_LEFT = col("EEF5FB"), ELE_RIGHT = col("BFD4E4");
function elephant(X, Y, facing, s, cargo){
  function part(u, v, z, du, dv, dz, top, bias){
    var a = facing == "x" ? [X + u*s, Y + v*s, du*s, dv*s] : [X + v*s, Y + u*s, dv*s, du*s];
    var t = top === undefined ? ELE_TOP : top;
    boxc(a[0], a[1], z*s, a[2], a[3], dz*s, t, t == ELE_TOP ? ELE_LEFT : WHITE, t == ELE_TOP ? ELE_RIGHT : WASH, bias);
  }
  // legs, tail and body
  part(0.3, 0.2, 0, 1.5, 1.5, 2.3); part(0.3, 2.3, 0, 1.5, 1.5, 2.3);
  part(4.2, 0.2, 0, 1.5, 1.5, 2.3); part(4.2, 2.3, 0, 1.5, 1.5, 2.3);
  part(-0.5, 1.8, 3.6, 0.5, 0.4, 1.2);
  part(0, 0, 2.2, 6, 4, 3.4);
  // head lower than the back, then the far ear behind it and the near ear in front
  part(6.1, -2.4, 2.2, 0.4, 2.9, 3.8, ELE_TOP, 0.2);
  part(5.8, 0.5, 2.6, 2.4, 3, 2.8, ELE_TOP, 0.3);
  part(6.1, 3.5, 2.2, 0.4, 2.9, 3.8, ELE_TOP, 0.7);
  // tusks, and a trunk that hangs and curls forward
  part(8.2, 0.8, 2.5, 0.9, 0.4, 0.4, WHITE, 0.75); part(8.2, 2.8, 2.5, 0.9, 0.4, 0.4, WHITE, 0.85);
  part(8.2, 1.55, 2.9, 0.9, 0.9, 1.5, ELE_TOP, 0.8);
  part(8.5, 1.6, 1.0, 0.8, 0.8, 1.9, ELE_TOP, 0.9);
  part(9.3, 1.6, 1.0, 0.7, 0.8, 0.7, ELE_TOP, 1.0);
  if (cargo) part(1.8, 0.8, 5.6, 2.4, 2.4, 2.4, cargo, 0.1);
  // the eye, on the side of the head that faces the reader
  var e = facing == "x" ? P(X + 7.3*s, Y + 3.5*s, 4.5*s) : P(X + 3.5*s, Y + 7.3*s, 4.5*s), r = 1.4 + s;
  items.push({k: (facing == "x" ? X + 7*s + Y + 2*s : X + 2*s + Y + 7*s) + 1.2, f: function(){ style(doc.pathItems.ellipse(e[1] + r, e[0] - r, 2*r, 2*r), INK); }});
}
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
