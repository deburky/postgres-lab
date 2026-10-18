// The home page scene: the elephant crew at work in an isometric Postgres world. Data arrives
// from the application on a belt, a queue worker picks it up, a carrier takes it up a ramp into
// the database, and on the far side it leaves down a chute, is wheeled away and stacked.
// Run in Illustrator 2020 on a new RGB document; the artboard is cropped to fit.
var SRC = new File($.fileName).parent + "/";
$.evalFile(new File(SRC + "iso.jsx"));
$.evalFile(new File(SRC + "workers.jsx"));
clear();
S = 11; OX = 520; OY = 640;

// the ground
drawBox(0, 6, -1.5, 84, 28, 1.5, WHITE);
tile(2, 10, 12, 14, LIME);
tile(64, 8, 18, 18, PEACH);
// the application's belt, with three jobs riding it
box(13, 15, 0, 17, 3, 2.4, STEEL);
box(16, 15.4, 2.4, 2.2, 2.2, 2.2, PEACH); box(21, 15.4, 2.4, 2.2, 2.2, 2.2, LIME); box(26, 15.4, 2.4, 2.2, 2.2, 2.2, VIO);
// a ramp up the front of the database to the hatch on top
items.push({k: 46 + 28, f: function(){
  poly([P(44.5, 32, 0), P(44.5, 23, 13.6), P(47.5, 23, 13.6), P(47.5, 32, 0)], KRAFT);
  poly([P(47.5, 32, 0), P(47.5, 23, 13.6), P(47.5, 23, 0)], WASH);
  for (var t = 0.15; t < 0.95; t += 0.17) line([P(44.5, 32 - 9 * t, 13.6 * t), P(47.5, 32 - 9 * t, 13.6 * t)]);
}});
// the database, with an open hatch
items.push({k: 46 + 17.5, f: function(){
  drawCyl(46, 17.5, 0, 14, 6, SKY, 2);
  var t = P(46, 17.5, 14), a = 1.2247 * 2.4 * S, b = 0.7071 * 2.4 * S;
  style(doc.pathItems.ellipse(t[1] + b, t[0] - a, 2 * a, 2 * b), INK);
  // centred in the top band, between the upper ring (z = 14 * 2/3) and the rim (z = 14)
  var label = text("Postgres", MONO, 15, INK), c = P(46, 17.5, 14 * 5 / 6), bb = 0.7071 * 6 * S;
  label.position = [c[0] - label.width / 2, c[1] - bb + label.height / 2];
}});
// out of the database down a chute, to the warehouse pile
box(52, 15.5, 0, 9, 3, 1.2, STEEL);
box(56, 15.9, 1.2, 2, 2, 2, YEL);
var pileAt = [[68, 12, 0, YEL], [71, 12, 0, LIME], [74, 12, 0, SKY], [68, 15, 0, VIO], [71, 15, 0, PEACH], [74, 15, 0, MINT],
              [68, 12, 3, PEACH], [71, 12, 3, SKY], [68, 15, 3, LIME], [71, 15, 3, YEL], [68, 12, 6, MINT]];
for (var i = 0; i < pileAt.length; i++) box(pileAt[i][0], pileAt[i][1], pileAt[i][2], 2.8, 2.8, 2.8, pileAt[i][3]);
box(55, 24, 0, 3.4, 3, 3);
// trees in the empty front corner
tree(6, 29, LIME); tree(11, 31, MINT); tree(17, 29.5, LIME); tree(23, 31.5, MINT); tree(29, 30, LIME);
// the crew
sprite("developer", 8, 18, 0, 30, 3, false, 2);
sprite("queueWorker", 32, 23, 0, 30, 14, true, -3);
sprite("carrier", 46, 28.5, 5.3, 30, 8, false, 2, 12);
sprite("researcher", 46, 17.5, 14, 22, -6, false, 3);
sprite("engineer", 56.5, 25.5, 3, 30, 10, false, -3);
sprite("mover", 61, 25, 0, 30, -10, false, 3, 12);
sprite("stacker", 71, 21, 0, 30, 12, true, -3);
sprite("clerk", 79, 26, 0, 30, 4, true, -3);
flush();
var vb = doc.visibleBounds;
doc.artboards[0].artboardRect = [vb[0] - 20, vb[1] + 20, vb[2] + 20, vb[3] - 20];
"crew drawn";
