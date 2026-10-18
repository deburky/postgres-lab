// The panel on the home page about the Postgres elephant: a crew member reads from the archive
// of mailing-list letters where the elephant was first suggested. Our own elephant, not the
// Slonik logo, which is a trademark. Run in Illustrator 2020 on a new RGB document; the artboard
// is cropped to fit. Export images/archive.svg with type outlined.
var SRC = new File($.fileName).parent + "/";
$.evalFile(new File(SRC + "iso.jsx"));
$.evalFile(new File(SRC + "workers.jsx"));
clear();
S = 12; OX = 280; OY = 330;
drawBox(0, 0, -1, 13, 13, 1, WHITE);
tile(1.2, 1.2, 10.6, 10.6, SKY);
// the archive: stacked letters on the left, a crate of data on the right
box(1.8, 7.2, 0, 3.6, 3, 1.1, WASH);
box(2.1, 7.4, 1.1, 3.2, 2.6, 1.1, WHITE);
box(1.9, 7.3, 2.2, 3.4, 2.8, 1.1, VIO);
box(7.4, 1.8, 0, 2.8, 2.8, 2.8, WHITE);
box(7.6, 2, 2.8, 2.4, 2.4, 2.4, YEL);
sprite("clerk", 8.6, 8.6, 0, 38, 4, true, -3);
flush();
var vb = doc.visibleBounds;
doc.artboards[0].artboardRect = [vb[0] - 12, vb[1] + 12, vb[2] + 12, vb[3] - 12];
"archive drawn";
