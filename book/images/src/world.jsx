// The cover map: Postgres at the centre of a plate, one district per part of the book.
// Run in Illustrator 2020 (File > Scripts > Other Script) on a new 1400 x 820 pt RGB document,
// then export images/world.svg with type outlined and images/world.png at 200%.
$.evalFile(new File($.fileName).parent + "/iso.jsx");
clear();
drawBox(0, 0, -2, 64, 64, 2, WHITE);
tile(2, 2, 16, 16, YEL); tile(46, 2, 16, 16, LIME); tile(2, 46, 16, 16, VIO); tile(44, 24, 16, 16, PEACH); tile(46, 46, 16, 16, MINT);
// Postgres from Python: a little town
box(4,4,0,4,4,5); box(10,4,0,5,4,8); box(4,10,0,4,5,3); box(11,11,0,5,5,6); box(5,15,0,3,2,2);
// Search: towers with room between them; the nearest neighbour, on the outer corner, in yellow
var hs = [[4,7,3],[8,5,6],[11,6,2]];
for (var gx = 0; gx < 3; gx++) for (var gy = 0; gy < 3; gy++) box(47.5 + gx*5.5, 3.5 + gy*5.5, 0, 2.6, 2.6, hs[gx][gy], (gx == 2 && gy == 0) ? YEL : WHITE);
// Queues: a conveyor with jobs, two workers
box(3, 50, 0, 13, 4, 1.2);
var jobs = [YEL, LIME, SKY, PEACH];
for (var j = 0; j < 4; j++) box(4 + j*3, 51, 1.2, 2, 2, 2, jobs[j]);
box(5, 56.5, 0, 3, 3, 6, VIO); box(11, 56.5, 0, 3, 3, 6);
// the database, a pipe to the warehouse
cyl(32, 32, 0, 13, 7.5, SKY, 2);
box(39, 31, 3, 9, 2, 2);
cyl(53, 32, 0, 8, 4.5, PEACH, 1);
// Access and operations: a gate and three pods
box(49, 50, 0, 1.2, 1.2, 8); box(57, 50, 0, 1.2, 1.2, 8); box(48.4, 50, 8, 10.4, 1.2, 1.4, YEL);
box(49, 56, 0, 2.6, 2.6, 2.6, SKY); box(53, 57, 0, 2.6, 2.6, 2.6, SKY); box(57, 56, 0, 2.6, 2.6, 2.6, LIME);
// trees in the front-left corner
tree(27,47,LIME); tree(32,50,MINT); tree(25,53,MINT); tree(36,55,LIME); tree(30,57,LIME); tree(21,49,LIME); tree(38,60,MINT);
flush();
// labels: every leader ends on a top face and comes in from outside the scene
var a;
a = P(6, 6, 5); card(330, 800, "Postgres from Python", "SQLAlchemy, JSONB, PgBouncer, PGlite", "r", a[0], a[1]);
a = P(59.8, 4.8, 11); card(1235, 700, "Search", "pgvector, three indexes, bulk loading", "b", a[0], a[1]);
a = P(6.5, 58, 6); card(150, 330, "Queues", "pgqueuer and pgmq", "t", a[0], a[1]);
a = P(53, 32, 4); card(1180, 320, "Moving data", "logical replication, Doris", "l", a[0] + 1.2247*4.5*S, a[1]);
a = P(58.8, 50.6, 9.4); card(1000, 200, "Access and operations", "access as code, Kubernetes", "l", a[0], a[1]);
var pg = text("Postgres 18", MONO, 15, INK);
pg.position = [700 - pg.width/2, 514];
// crop the artboard to the art plus a margin
var vb = doc.visibleBounds, m = 24;
doc.artboards[0].artboardRect = [vb[0] - m, vb[1] + m, vb[2] + m, vb[3] - m];
"world drawn";
