const fs = require('fs');
const base = 'c:/Users/pc/Downloads/Project 2/anime-stream/src/components/';
function dumpFile(name, fromLine, toLine, label) {
  const path = base + name;
  const s = fs.readFileSync(path, 'utf8');
  const b = s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  const lines = b.split(/\r?\n/);
  console.log('\n-- ' + (label || name) + ' L' + fromLine + '-' + toLine + ' --');
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) console.log((i + 1) + ': ' + lines[i]);
}
dumpFile('video-player.tsx', 412, 495, 'VP HANDLERS');
dumpFile('status-overlays.tsx', 90, 118, 'CenterPlayButton');
dumpFile('status-overlays.tsx', 110, 145, 'ResumeChipProps+Start');
dumpFile('status-overlays.tsx', 130, 145, 'ResumeChip end');
dumpFile('status-overlays.tsx', 145, 200, 'SkipButtons + FillerBadge + LiveDot');
dumpFile('autoplay-next-countdown.tsx', 1, 55, 'AutoplayNextCounter');