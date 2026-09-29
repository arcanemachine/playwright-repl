// Recording a tab's page to a video, from Chrome's screencast of it through ffmpeg.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { state, onShutdown } = require('./state');
const out = require('./output');
const { tabState } = require('./tabstate');
const { clock, NO_TAB } = require('./util');

const FPS = 25;
const MAX_SECONDS = 3600;
// Frames waiting for ffmpeg past this are dropped rather than held in memory.
const MAX_QUEUED = 32 * 1024 * 1024;
// How long ffmpeg may go without progress on the frames still queued for it before it is stopped,
// and the file may be cut short; at shutdown, how long it may take at all, within the REPL's cleanup.
const FINISH_TIMEOUT = 5000;
const SHUTDOWN_FINISH_TIMEOUT = 3000;
const FIRST_FRAME_TIMEOUT = 2000;
const INSTALL = 'npx playwright-core install ffmpeg (WebM only), or ffmpeg from your system\'s packages';
// One thread each: ffmpeg's default of one per core thrashes on a busy machine (a 720p WebM took
// 26s of work for 10s of video with 20 cores, and 1s with one thread), and it shares the machine
// with the browser it records.
const FORMATS = {
  webm: { encoder: 'libvpx', args: ['-c:v', 'vp8', '-b:v', '2M', '-g', String(FPS * 2), '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1'] },
  // Fragmented, so a recording cut short still plays up to its last fragment.
  mp4: { encoder: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '1', '-g', String(FPS * 2), '-movflags', '+frag_keyframe+empty_moov+default_base_moof'] },
};

// PW_FFMPEG, then Playwright's own (wherever PLAYWRIGHT_BROWSERS_PATH puts it), then one on the PATH.
function ffmpegCandidates() {
  const found = [];
  if (process.env.PW_FFMPEG) found.push(process.env.PW_FFMPEG);
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^ffmpeg-\d+$/.test(n)).sort().reverse(); } catch {}
  for (const name of names) {
    for (const exe of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe']) {
      const candidate = path.join(dir, name, exe);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  for (const folder of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(folder, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try { fs.accessSync(candidate, fs.constants.X_OK); found.push(candidate); } catch {}
  }
  return [...new Set(found)];
}

const encoderLists = new Map();

function hasEncoder(exe, encoder) {
  if (!encoderLists.has(exe)) {
    let list = '';
    try { list = execFileSync(exe, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); } catch {}
    encoderLists.set(exe, list);
  }
  return new RegExp(`^\\s*V\\S*\\s+${encoder}\\s`, 'm').test(encoderLists.get(exe));
}

// The first ffmpeg that can write the format.
function findFfmpeg(format) {
  const candidates = ffmpegCandidates();
  if (!candidates.length) throw new Error(`record needs ffmpeg, and none was found: ${INSTALL}; PW_FFMPEG names one`);
  const exe = candidates.find(c => hasEncoder(c, FORMATS[format].encoder));
  if (exe) return exe;
  if (format === 'mp4') throw new Error(`No ffmpeg found can write MP4 (H.264): Playwright's writes only WebM. Install ffmpeg from your system's packages, or name one with PW_FFMPEG; or record to a .webm file`);
  throw new Error(`No ffmpeg found can write WebM (VP8): ${INSTALL}; PW_FFMPEG names one`);
}

// A JPEG's width and height, from its frame header.
function jpegSize(buffer) {
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
    }
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return null;
}

function nextRecordingPath() {
  // Where screenshots go, so both are found in one place.
  return path.join(process.env.PW_SCREENSHOT_DIR || state.ownDir || '/tmp', `recording-${Date.now()}.webm`);
}

function sizeText(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Each client's last recording that ended, and how, for record to report: one that ends on
// its own (its seconds, its tab closing) says so only in the pane.
const lastEnded = new Map();
// Each client's recordings still being saved, which record waits for before it reports.
const saving = new Map();

function recordingOf(p) {
  return tabState(p).recording || null;
}

// The tabs recording now, for the modes they count as.
function recordingPages() {
  if (!state.browser) return [];
  return state.browser.contexts().flatMap(c => c.pages()).filter(p => recordingOf(p));
}

async function startRecording(p, file, seconds, format) {
  const exe = findFfmpeg(format);
  // As screenshot does: a tab that has not been in front since it was emulated as a phone can
  // be drawn at the window's size.
  await p.bringToFront();
  // Its own session: Chrome keeps one screencast per session, and the kept session's keeps the tab drawing.
  const session = await p.context().newCDPSession(p);
  const rec = {
    page: p, file, format, exe, session, owner: state.client, startedAt: Date.now(), firstFrameAt: null,
    size: null, resizedAt: null, written: 0, dropped: 0, latest: null, ff: null, timer: null, limit: null, finishing: null,
    ffmpegError: '',
  };
  // The size is the page's as the screen shows it, in CSS pixels (a phone's too, whose frames come in
  // its device pixels), and Chrome scales each frame to fit it. Not the first frame's: just after a
  // reload or a change of emulation, that can still be the window's.
  const even = n => Math.max(2, Math.round(n) - (Math.round(n) % 2));
  try {
    const { cssVisualViewport: vv } = await session.send('Page.getLayoutMetrics');
    rec.size = { width: even(vv.clientWidth * (vv.scale || 1)), height: even(vv.clientHeight * (vv.scale || 1)) };
  } catch (error) {
    session.detach().catch(() => {});
    throw error;
  }
  tabState(p).recording = rec;
  let firstFrame;
  const gotFirstFrame = new Promise(resolve => { firstFrame = resolve; });
  const tick = () => {
    if (!rec.latest || !rec.ff || rec.finishing) return;
    // The video keeps the wall clock: Chrome sends a frame only when the page redraws,
    // so the latest one is repeated while the page is still.
    const due = Math.floor(((Date.now() - rec.firstFrameAt) / 1000) * FPS);
    for (; rec.written < due; rec.written++) {
      if (rec.ff.stdin.writableLength > MAX_QUEUED) { rec.dropped += 1; continue; }
      rec.ff.stdin.write(rec.latest);
    }
  };
  session.on('Page.screencastFrame', frame => {
    session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (rec.finishing) return;
    const image = Buffer.from(frame.data, 'base64');
    const size = jpegSize(image);
    if (!size) return;
    // A frame the size of the video, to a pixel (Chrome scales it to fit, keeping its shape).
    const fits = Math.abs(size.width - rec.size.width) <= 1 && Math.abs(size.height - rec.size.height) <= 1;
    if (!rec.ff) {
      rec.firstFrameAt = Date.now();
      rec.ff = spawnFfmpeg(rec);
      rec.timer = setInterval(tick, 1000 / FPS);
      firstFrame();
    } else {
      tick();
      // Once the page has been drawn at its size, one of another size means it changed; it is
      // fitted into the video's.
      if (rec.resizedAt === null && rec.fitted && !fits) rec.resizedAt = (Date.now() - rec.firstFrameAt) / 1000;
    }
    if (fits) rec.fitted = true;
    rec.latest = image;
  });
  try {
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: rec.size.width, maxHeight: rec.size.height });
  } catch (error) {
    delete tabState(p).recording;
    session.detach().catch(() => {});
    throw error;
  }
  // Chrome sends the page as it is at once; the recording starts with it. A page that has not
  // drawn yet (a tab still opening) starts it when it does.
  await Promise.race([gotFirstFrame, new Promise(resolve => setTimeout(resolve, FIRST_FRAME_TIMEOUT))]);
  rec.limit = setTimeout(() => {
    finishRecording(rec, `It reached its ${seconds}s and stopped`).then(text => out.notice(text, p));
  }, seconds * 1000);
  rec.onClose = () => finishRecording(rec, 'Its tab closed, which ended it').then(text => out.notice(text, p));
  p.once('close', rec.onClose);
  return rec;
}

function spawnFfmpeg(rec) {
  const { width, height } = rec.size;
  // A frame of another size (the viewport or window changed) is scaled to fit, and centred.
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
  // Warnings too (an empty output is one), kept for a failure's message only.
  const ff = spawn(rec.exe, ['-hide_banner', '-loglevel', 'warning', '-threads', '1', '-filter_threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', String(FPS), '-i', 'pipe:0',
    '-vf', fit, ...FORMATS[rec.format].args, '-an', '-y', rec.file], { stdio: ['pipe', 'ignore', 'pipe'] });
  ff.stderr.setEncoding('utf8');
  ff.stderr.on('data', chunk => { rec.ffmpegError = (rec.ffmpegError + chunk).slice(-2000); });
  // A write after ffmpeg has gone is reported when the recording finishes, not thrown.
  ff.stdin.on('error', () => {});
  ff.on('error', error => { rec.ffmpegError += error.message; });
  rec.exited = new Promise(resolve => ff.once('close', code => resolve(code)));
  return ff;
}

// Stops the screencast, lets ffmpeg finish the file, and says what was saved. Once per recording.
function finishRecording(rec, why = null, { shuttingDown = false } = {}) {
  if (rec.finishing) return rec.finishing;
  const owner = rec.owner ?? null;
  const stoppedAt = Date.now();
  rec.finishing = (async () => {
    const result = await finishFile(rec, shuttingDown);
    const text = typeof result === 'string' ? result : result.text;
    // A recording that saved nothing makes record off fail, rather than report it as done.
    rec.failed = typeof result !== 'string';
    const said = why ? `${why}. ${text}` : text;
    lastEnded.set(owner, { text: said, at: stoppedAt });
    return said;
  })();
  const pending = saving.get(owner) || new Set();
  saving.set(owner, pending.add(rec.finishing));
  rec.finishing.finally(() => pending.delete(rec.finishing)).catch(() => {});
  return rec.finishing;
}

async function finishFile(rec, shuttingDown) {
  clearTimeout(rec.limit);
  if (rec.onClose) rec.page.off('close', rec.onClose);
  if (tabState(rec.page).recording === rec) delete tabState(rec.page).recording;
  // The last frame runs to now, and a recording has one frame at least.
  if (rec.ff && rec.latest) {
    const due = Math.max(1, Math.floor(((Date.now() - rec.firstFrameAt) / 1000) * FPS));
    for (; rec.written < due; rec.written++) rec.ff.stdin.write(rec.latest);
  }
  clearInterval(rec.timer);
  await rec.session.send('Page.stopScreencast').catch(() => {});
  rec.session.detach().catch(() => {});
  if (!rec.ff) {
    fs.rmSync(rec.file, { force: true });
    return { failed: true, text: `Nothing was recorded: the tab drew no frame, so no file was saved (${rec.file}).` };
  }
  rec.ff.stdin.end();
  let cut = false;
  // Frames still queued are encoded before the file is done, however long that takes, while
  // ffmpeg keeps getting through them.
  const progress = () => `${rec.ff.stdin.writableLength}:${fs.existsSync(rec.file) ? fs.statSync(rec.file).size : 0}`;
  const stalled = new Promise(resolve => {
    if (shuttingDown) { setTimeout(() => resolve('timeout'), SHUTDOWN_FINISH_TIMEOUT); return; }
    let last = progress();
    let since = Date.now();
    const check = setInterval(() => {
      const now = progress();
      if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since > FINISH_TIMEOUT) { clearInterval(check); resolve('timeout'); }
    }, 250);
    rec.exited.then(() => clearInterval(check));
  });
  const code = await Promise.race([rec.exited, stalled]);
  if (code === 'timeout') { cut = true; rec.ff.kill('SIGKILL'); await rec.exited; }
  const seconds = (rec.written - rec.dropped) / FPS;
  const saved = fs.existsSync(rec.file) ? fs.statSync(rec.file).size : 0;
  if (!saved) {
    fs.rmSync(rec.file, { force: true });
    const why = cut ? 'it stopped making progress and was stopped' : `it exited with ${code}${rec.ffmpegError ? `: ${rec.ffmpegError.trim()}` : ', saying nothing'}`;
    return { failed: true, text: `Nothing was saved: ffmpeg wrote no video (${rec.written} frames sent; ${why}).` };
  }
  const notes = [];
  if (rec.resizedAt !== null) notes.push(`the page changed size at ${rec.resizedAt.toFixed(1)}s and was fitted into the first size`);
  if (rec.dropped) notes.push(`${rec.dropped} frames dropped, ${(rec.dropped / FPS).toFixed(1)}s, while ffmpeg fell behind`);
  if (cut) notes.push(`ffmpeg ${shuttingDown ? `did not finish within ${SHUTDOWN_FINISH_TIMEOUT / 1000}s as the REPL stopped` : 'stopped making progress'} and was stopped, so the file is likely cut short of the ${seconds.toFixed(1)}s recorded`);
  else if (code !== 0) notes.push(`ffmpeg exited with ${code}${rec.ffmpegError ? `: ${rec.ffmpegError.trim()}` : ''}`);
  return `Saved: ${rec.file} (${seconds.toFixed(1)}s, ${rec.size.width}x${rec.size.height}, ${sizeText(saved)})${notes.length ? `\n${notes.join('; ')}` : ''}`;
}

// Ends every recording, as the REPL stops, and says in the pane and the log what each saved.
async function finishAll() {
  await Promise.all(recordingPages().map(p => finishRecording(recordingOf(p), 'The REPL stopped, which ended a recording', { shuttingDown: true }).then(text => out.log(text), () => {})));
}

onShutdown(finishAll);

function statusText(p) {
  const rec = recordingOf(p);
  if (!rec) {
    const last = lastEnded.get(state.client ?? null);
    return `The selected tab is not being recorded; record on starts it.${last ? `\nYour last recording, ended at ${clock(last.at)}: ${last.text}` : ''}`;
  }
  const since = ((Date.now() - (rec.firstFrameAt || rec.startedAt)) / 1000).toFixed(1);
  const size = rec.size ? `, ${rec.size.width}x${rec.size.height}` : ', no frame yet';
  const resized = rec.resizedAt !== null ? `; the page changed size at ${rec.resizedAt.toFixed(1)}s and is fitted into the first size` : '';
  return `Recording the selected tab to ${rec.file} since ${clock(rec.startedAt)} (${since}s${size})${rec.owner ? `, by ${rec.owner}` : ''}${resized}; record off stops it and saves the file.`;
}

// A file word, as given or as playwright-cli's --filename=<file> (or --filename <file>); any other
// option is refused, never taken for a file name.
function fileWords(words, usage) {
  const files = [];
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith('--filename=') && word.length > 11) files.push(word.slice(11));
    else if (word === '--filename' && words[i + 1]) files.push(words[++i]);
    else if (word.startsWith('-')) throw new Error(`record takes no ${word}. ${usage}`);
    else if (/^\d+$/.test(word)) rest.push(word);
    else files.push(word);
  }
  if (files.length > 1) throw new Error(usage);
  return { file: files.length ? path.resolve(files[0]) : null, rest };
}

function checkFile(file, format) {
  const ext = path.extname(file).toLowerCase().slice(1);
  if (!FORMATS[ext]) throw new Error(`A recording is a .webm or .mp4 file, not ${path.basename(file)}`);
  if (format && ext !== format) throw new Error(`This recording is ${format === 'webm' ? 'WebM' : 'MP4'}: name it .${format}, not ${path.basename(file)}`);
  if (fs.existsSync(file)) throw new Error(`Recording already exists: ${file}`);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`No folder ${path.dirname(file)} to save ${path.basename(file)} in`);
  return ext;
}

// Moves a saved recording to the name record off was given, across file systems too.
function moveRecording(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, 0o600);
    fs.unlinkSync(from);
  }
}

const commands = {
  async record(args) {
    const words = (args || '').trim().split(/\s+/).filter(Boolean);
    const usage = `Usage: record [on [file.webm|file.mp4] [seconds] | off [file]] (seconds from 1 to ${MAX_SECONDS})`;
    if (!words.length) {
      await Promise.allSettled([...(saving.get(state.client ?? null) || [])]);
      out.log(statusText(state.page));
      return;
    }
    const [what, ...rest] = words;
    // record on its own works with no tab selected, as after the recorded tab closed.
    if (!state.page || state.page.isClosed()) throw new Error(NO_TAB);
    if (what !== 'on' && what !== 'off') throw new Error(usage);
    // A file given is relative to the REPL's folder; pw-repl send makes it the sender's.
    const { file: named, rest: numbers } = fileWords(rest, usage);
    if (what === 'off') {
      if (numbers.length) throw new Error(usage);
      const rec = recordingOf(state.page);
      if (!rec) {
        await Promise.allSettled([...(saving.get(state.client ?? null) || [])]);
        out.log(statusText(state.page));
        return;
      }
      // Its own name again (named at both ends, as playwright-cli habits have it) is no rename.
      const rename = named && named !== rec.file ? named : null;
      // Checked first, so a name that cannot be used leaves it recording, and says so.
      if (rename) {
        try { checkFile(rename, rec.format); } catch (error) { throw new Error(`${error.message}; still recording to ${rec.file}`); }
      }
      const text = await finishRecording(rec);
      if (rec.failed) throw new Error(text);
      if (!rename || !fs.existsSync(rec.file)) { out.log(text); return; }
      moveRecording(rec.file, rename);
      const last = lastEnded.get(rec.owner ?? null);
      if (last) last.text = last.text.split(rec.file).join(rename);
      out.log(text.split(rec.file).join(rename));
      return;
    }
    if (numbers.length > 1) throw new Error(usage);
    const seconds = numbers.length ? Number(numbers[0]) : MAX_SECONDS;
    if (seconds < 1 || seconds > MAX_SECONDS) throw new Error(usage);
    const file = named || nextRecordingPath();
    const current = recordingOf(state.page);
    if (current) throw new Error(`The selected tab is already being recorded to ${current.file}; record off stops it`);
    const format = checkFile(file);
    findFfmpeg(format);
    // Created here, owner-only as a screenshot is, since a recording shows whatever the page does;
    // ffmpeg writes over it and keeps the mode. It never replaces a file.
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Recording already exists: ${file}`);
      throw error;
    }
    try {
      await startRecording(state.page, file, seconds, format);
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    }
    const limit = numbers.length ? `for ${seconds}s` : `until record off (at most ${MAX_SECONDS / 60} minutes)`;
    out.log(`Recording the selected tab to ${file} ${limit}; record off stops it and saves the file.`);
  },
};

module.exports = { commands, recordingOf, finishRecording, findFfmpeg, jpegSize };
