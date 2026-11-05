#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = path.join(root, 'test-results/presentation');
const out = path.join(root, 'docs/demo');
const capture = JSON.parse(await readFile(path.join(raw, 'capture.json'), 'utf8'));
await mkdir(out, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}
const duration = Number(JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', capture.video])).format.duration);
const metadata = [';FFMETADATA1', 'title=DevOps Playground - Deploy. Diagnose. Recover.',
  'artist=Nadjide Omar', 'comment=Actual browser demo recording. All operations shown are simulated.'];
for (const [index, chapter] of capture.chapters.entries()) {
  metadata.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.floor(chapter.start * 1000)}`,
    `END=${Math.floor((capture.chapters[index + 1]?.start ?? duration) * 1000)}`, `title=${chapter.title}`);
}
const chapterFile = path.join(raw, 'chapters.ffmeta');
await writeFile(chapterFile, metadata.join('\n'));
run('ffmpeg', ['-y', '-v', 'error', '-i', capture.video, '-i', chapterFile, '-map_metadata', '1', '-map_chapters', '1',
  '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  path.join(out, 'devops-playground.mp4')]);

// Show each chapter's outcome without changing application state or playback speed.
const filters = capture.chapters.map((chapter, index) => {
  const end = capture.chapters[index + 1]?.start ?? duration;
  return `[0:v]trim=start=${Math.max(chapter.start, end - 5)}:end=${end},setpts=PTS-STARTPTS[v${index}]`;
});
filters.push(`${capture.chapters.map((_, index) => `[v${index}]`).join('')}concat=n=${capture.chapters.length}:v=1:a=0,fps=6,scale=960:-2:flags=lanczos,split[a][b]`,
  '[a]palettegen=max_colors=96:stats_mode=diff[p]', '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle');
run('ffmpeg', ['-y', '-v', 'error', '-i', capture.video, '-filter_complex', filters.join(';'), '-loop', '0',
  path.join(out, 'devops-playground.gif')]);
await writeFile(path.join(out, 'recording.json'), JSON.stringify({ sourceCommit: capture.commit,
  mode: capture.mode, viewport: capture.viewport, durationSeconds: duration, chapters: capture.chapters,
  preview: 'Four 5-second excerpts, 6 fps, 960px wide; no fabricated application state.',
  backendRequests: capture.backendRequests }, null, 2) + '\n');
console.log(`Encoded ${duration.toFixed(1)}s video with chapters and a 20s README preview.`);
