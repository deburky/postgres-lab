// Spot illustrations, one per part of the book: each is its district from the cover map, closer up.
// Load iso.jsx first, set SPOT to 1..5, then run on a new RGB document; the artboard is cropped to fit.
S = 12; OX = 280; OY = 330;
function plate(fill){
  drawBox(0, 0, -1, 24, 24, 1, WHITE);
  tile(1.5, 1.5, 21, 21, fill);
}
function dashed(pts){ var p = line(pts); p.strokeDashes = [5, 5]; return p; }
var SPOTS = {
  // Postgres from Python: the town talks to the database over two pipes, sync and async
  1: function(){
    plate(YEL);
    box(2,5,0,4,5,7); box(3,13,0,3,4,5); box(8,15,0,3,3,3); box(3,19,0,3,2,2); box(14,16,0,4,4,4);
    box(6,5.6,4,6.5,1.2,1.2); box(6,8.2,1.5,6.5,1.2,1.2);
    cyl(16, 7.5, 0, 8, 4.5, SKY, 2);
    flush();
  },
  // Search: a field of towers; the question floats above the nearest one
  2: function(){
    plate(LIME);
    // the nearest neighbour is the back tower, so the line up to the question crosses nothing
    var h = [[6,4,2,5],[7,3,8,3],[2,5,4,2],[6,3,2,2]];
    for (var gx = 0; gx < 4; gx++) for (var gy = 0; gy < 4; gy++) box(3 + gx*5, 3 + gy*5, 0, 2.6, 2.6, h[gx][gy], (gx == 0 && gy == 0) ? YEL : WHITE);
    flush();
    var top = P(4.3, 4.3, 6), q = P(4.3, 4.3, 14), r = 12;
    dashed([[top[0], top[1]], [q[0], q[1] - r]]);
    style(doc.pathItems.ellipse(q[1] + r, q[0] - r, 2*r, 2*r), VIO);
  },
  // Queues: jobs wait on a conveyor in front of three workers; the first worker holds one on its roof
  3: function(){
    plate(VIO);
    box(4, 3, 0, 4, 4, 6); box(10, 3, 0, 4, 4, 6, VIO); box(16, 3, 0, 4, 4, 6);
    box(4.8, 3.8, 6, 2.4, 2.4, 2.4, LIME);
    box(2, 13, 0, 20, 4, 1.4);
    var jobs = [YEL, LIME, SKY, PEACH, YEL];
    for (var j = 0; j < 5; j++) box(3 + j*3.6, 14, 1.4, 2.4, 2.4, 2.4, jobs[j]);
    flush();
  },
  // Moving data: rows travel along a pipe from Postgres to the warehouse
  4: function(){
    plate(PEACH);
    cyl(4.5, 14, 0, 8, 4, SKY, 2);
    box(7, 10.4, 2.5, 10, 1.6, 1.6);
    box(9.5, 10.4, 4.1, 1.6, 1.6, 1.6, YEL); box(13, 10.4, 4.1, 1.6, 1.6, 1.6, LIME);
    cyl(19.5, 8, 0, 6, 4, PEACH, 1);
    flush();
  },
  // Access and operations: a gate, three pods, and the spec that says who may pass
  5: function(){
    plate(MINT);
    box(4, 4, 0, 1.4, 1.4, 9); box(13, 4, 0, 1.4, 1.4, 9); box(3.3, 4, 9, 11.8, 1.4, 1.6, YEL);
    box(5, 12, 0, 3.4, 3.4, 3.4, SKY); box(10.5, 13, 0, 3.4, 3.4, 3.4, SKY); box(16, 12, 0, 3.4, 3.4, 3.4, LIME);
    box(16, 3, 0, 5, 6.5, 0.4);
    flush();
    for (var i = 0; i < 4; i++) line([P(17, 4 + i*1.4, 0.4), P(i == 3 ? 18.5 : 20, 4 + i*1.4, 0.4)]);
  }
};
clear();
SPOTS[SPOT]();
// crop the artboard to the art plus a margin
var vb = doc.visibleBounds;
doc.artboards[0].artboardRect = [vb[0] - 16, vb[1] + 16, vb[2] + 16, vb[3] - 16];
"spot " + SPOT + " drawn";
