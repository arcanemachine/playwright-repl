// Recording a tab's page to a video, from Chrome's screencast of it through ffmpeg.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { state, onShutdown } = require('./state');
const out = require('./output');
const { tabState } = require('./tabstate');
const { clock, NO_TAB, STOPPED_RECORDING, ENDED_UNSEEN, playwrightBrowsersDir } = require('./util');
const { shellWords, splitSelector } = require('./syntax');
const { reapplyMetrics } = require('./emulation');

const FPS = 25;
const MAX_SECONDS = 3600;
// While recording: a moment after each action for its result to be seen, and still page at both ends,
// so a video neither starts nor stops on an action (record on --pause, --lead, --tail).
const PACING = { pause: 750, lead: 1000, tail: 1000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

const FORMAT_NAMES = { webm: 'WebM (VP8)', mp4: 'MP4 (H.264)' };

// Playwright's own (wherever PLAYWRIGHT_BROWSERS_PATH puts it), then one on the PATH.
function ffmpegCandidates() {
  const found = [];
  const dir = playwrightBrowsersDir();
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

// What an ffmpeg's -encoders lists, or why it could not say. Only a list is kept: a probe that
// failed, as one slowed past its timeout on a busy machine can, is tried again the next time.
function encoderList(exe) {
  if (encoderLists.has(exe)) return { list: encoderLists.get(exe) };
  try {
    const list = execFileSync(exe, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    encoderLists.set(exe, list);
    return { list };
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'not found' };
    if (error.code === 'EACCES') return { error: 'not executable' };
    if (error.code === 'ETIMEDOUT') return { error: '-encoders did not answer within 5s' };
    return { error: `-encoders failed (${error.status !== null && error.status !== undefined ? `exit ${error.status}` : error.signal || error.message})` };
  }
}

function hasEncoder(list, encoder) {
  return new RegExp(`^\\s*V\\S*\\s+${encoder}\\s`, 'm').test(list || '');
}

// PW_FFMPEG when it is set, and never another in its place; otherwise the first ffmpeg that can
// write the format.
function findFfmpeg(format) {
  const { encoder } = FORMATS[format];
  const named = process.env.PW_FFMPEG;
  if (named) {
    const { list, error } = encoderList(named);
    if (error) throw new Error(`PW_FFMPEG=${named} cannot be used: ${error}`);
    if (!hasEncoder(list, encoder)) throw new Error(`PW_FFMPEG=${named} cannot write ${FORMAT_NAMES[format]}: its -encoders lists no ${encoder}`);
    return named;
  }
  const candidates = ffmpegCandidates();
  if (!candidates.length) {
    const how = format === 'mp4' ? 'an .mp4 needs ffmpeg from your system\'s packages, with H.264 (Playwright\'s writes only WebM)' : INSTALL;
    throw new Error(`record needs ffmpeg, and none was found: ${how}; PW_FFMPEG names one`);
  }
  const exe = candidates.find(c => hasEncoder(encoderList(c).list, encoder));
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

async function restoreMetrics(p, rec) {
  if (rec?.finishing) return;
  await reapplyMetrics(p);
}

// The tabs recording now, for the modes they count as.
function recordingPages() {
  if (!state.browser) return [];
  return state.browser.contexts().flatMap(c => c.pages()).filter(p => recordingOf(p));
}

async function startRecording(p, file, seconds, format, keepSteps, pacing) {
  const exe = findFfmpeg(format);
  // As screenshot does: a tab that has not been in front since it was emulated as a phone can
  // be drawn at the window's size.
  await p.bringToFront();
  // Bringing an emulated tab to the front can leave Chrome's capture surface at the window's size
  // after its next navigation. Reapply the active screen metrics on the kept session before measuring
  // or starting this recording, then wait for the page to draw at them.
  await restoreMetrics(p);
  // Its own session: Chrome keeps one screencast per session, and the kept session's keeps the tab drawing.
  const session = await p.context().newCDPSession(p);
  const rec = {
    page: p, file, format, exe, session, owner: state.client, startedAt: Date.now(), firstFrameAt: null,
    size: null, resizedAt: null, written: 0, dropped: 0, latest: null, ff: null, timer: null, limit: null, finishing: null,
    ffmpegError: '', starting: true, scale: 1, keepSteps, pacing, steps: [], step: null, stepsFile: null,
    holdFrames: false, restarting: false, navigationVersion: 0, restoreError: null, mainFrameId: null, screencastParams: null,
  };
  // The size is the page's as the screen shows it, in CSS pixels (a phone's too, whose frames come in
  // its device pixels), and Chrome scales each frame to fit it. Not the first frame's: just after a
  // reload or a change of emulation, that can still be the window's. Its scrollbars too, as the
  // frames have them (innerWidth has them; the viewport's clientWidth does not).
  const even = n => Math.max(2, Math.round(n) - (Math.round(n) % 2));
  try {
    await session.send('Page.enable');
    const tree = await session.send('Page.getFrameTree');
    rec.mainFrameId = tree.frameTree.frame.id;
    // Full document navigations reset Chrome's capture surface; SPA route changes do not.
    session.on('Page.frameNavigated', ({ frame }) => {
      if (frame.id !== rec.mainFrameId || rec.finishing) return;
      rec.navigationVersion += 1;
      const tab = tabState(p);
      rec.holdFrames = !!(tab.viewport || tab.emulation?.device);
    });
    session.on('Page.domContentEventFired', async () => {
      if (!rec.holdFrames || rec.finishing) return;
      const version = rec.navigationVersion;
      try {
        await restoreMetrics(p, rec);
        if (rec.finishing || version !== rec.navigationVersion) return;
        await session.send('Page.stopScreencast');
        if (rec.finishing || version !== rec.navigationVersion) return;
        rec.holdFrames = false;
        rec.restarting = true;
        await session.send('Page.startScreencast', rec.screencastParams);
      } catch (error) {
        if (rec.finishing || p.isClosed() || version !== rec.navigationVersion) return;
        rec.restoreError = error.message;
        out.notice(await finishRecording(rec, `Could not restore the recording size: ${error.message}`), p);
      }
    });
    const { cssVisualViewport: vv } = await session.send('Page.getLayoutMetrics');
    const { result } = await session.send('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true });
    const [width, height] = result.value;
    rec.scale = vv.scale || 1;
    rec.size = { width: even(width * rec.scale), height: even(height * rec.scale) };
    rec.screencastParams = { format: 'jpeg', quality: 85, maxWidth: rec.size.width, maxHeight: rec.size.height };
  } catch (error) {
    session.detach().catch(() => {});
    throw error;
  }
  tabState(p).recording = rec;
  let firstFrame;
  const gotFirstFrame = new Promise(resolve => { firstFrame = resolve; });
  const tick = () => {
    if (!rec.latest || !rec.ff || rec.ffExited || rec.finishing) return;
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
    if (rec.restarting && rec.latest) {
      if (!fits) { tick(); return; }
      rec.restarting = false;
    }
    if (rec.holdFrames && rec.latest) { tick(); return; }
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
    await session.send('Page.startScreencast', rec.screencastParams);
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
  rec.onClose = () => finishRecording(rec, TAB_CLOSED).then(text => out.notice(text, p));
  p.once('close', rec.onClose);
  // A new page, loaded or routed to by a single-page app, is a step of its own, for whoever edits the
  // video to cut or caption there. Its URL is left out, as a step's values are.
  rec.onNavigated = frame => {
    if (frame !== p.mainFrame() || rec.finishing || !keepSteps) return;
    const t = videoTime(rec);
    // An app that sets its URL twice in a row (push, then replace) is one new page.
    const last = rec.steps[rec.steps.length - 1];
    if (last?.command === '(page)' && t - last.t0 < 0.5) return;
    rec.steps.push({ rec, t0: t, t1: t, command: '(page)', box: null, point: null, offSize: false, failed: false });
  };
  p.on('framenavigated', rec.onNavigated);
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
  rec.exited = new Promise(resolve => ff.once('close', (code, signal) => {
    rec.ffExited = true;
    resolve(code ?? signal);
    // ffmpeg gone before record off ends the recording now, so no one goes on thinking it records;
    // record on, still starting it, says so itself.
    if (!rec.finishing) {
      rec.exitedEarly = true;
      finishRecording(rec, 'ffmpeg exited while recording, which ended it (help record --all)').then(text => { if (!rec.starting) out.notice(text, rec.page); });
    }
  }));
  return ff;
}

// An exit code, or the signal that ended ffmpeg.
function exitText(code) {
  return typeof code === 'string' ? `was killed by ${code}` : `exited with ${code}`;
}

// Stops the screencast, lets ffmpeg finish the file, and says what was saved. Once per recording.
function finishRecording(rec, why = null, { shuttingDown = false } = {}) {
  if (rec.finishing) return rec.finishing;
  const owner = rec.owner ?? null;
  const stoppedAt = Date.now();
  rec.finishing = (async () => {
    const result = await finishFile(rec, shuttingDown);
    const text = typeof result === 'string' ? result : result.text;
    // A recording that saved nothing, or that ffmpeg cut short, makes record off fail rather than
    // report it as done.
    rec.failed = typeof result !== 'string' || !!rec.exitedEarly || !!rec.restoreError;
    const said = why ? `${why}. ${text}` : text;
    // A failure is kept unreported until record off (or record on) has failed with it. One that
    // ended by itself is unseen until record shows it, and the REPL stopping logs it for stop.
    lastEnded.set(owner, { text: said, at: stoppedAt, failed: rec.failed, reported: false, seen: !why || shuttingDown });
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
  if (rec.onNavigated) rec.page.off('framenavigated', rec.onNavigated);
  if (tabState(rec.page).recording === rec) delete tabState(rec.page).recording;
  // The last frame runs to now, and a recording has one frame at least.
  if (rec.ff && rec.latest && !rec.ffExited) {
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
    const why = cut ? 'it stopped making progress and was stopped' : `it ${exitText(code)}${rec.ffmpegError ? `: ${rec.ffmpegError.trim()}` : ', saying nothing'}`;
    return { failed: true, text: `Nothing was saved: ffmpeg wrote no video (${rec.written} frames sent; ${why}).` };
  }
  const notes = [];
  if (rec.resizedAt !== null) notes.push(`the page changed size at ${rec.resizedAt.toFixed(1)}s and was fitted into the first size (help record --all)`);
  if (rec.dropped) notes.push(`${rec.dropped} frames dropped, ${(rec.dropped / FPS).toFixed(1)}s, while ffmpeg fell behind`);
  // An ffmpeg stopped before it finished leaves only what it had written, which it writes in
  // blocks: seconds of video short of the frames it was sent, and no length in the file's header.
  const short = `so the file holds only what it had written, short of the ${seconds.toFixed(1)}s recorded, and may not show its length or seek`;
  if (cut) notes.push(`ffmpeg ${shuttingDown ? `did not finish within ${SHUTDOWN_FINISH_TIMEOUT / 1000}s as the REPL stopped` : 'stopped making progress'} and was stopped, ${short}`);
  else if (rec.exitedEarly) notes.push(`ffmpeg ${exitText(code)}${rec.ffmpegError ? ` (${rec.ffmpegError.trim()})` : ''}, ${short}`);
  else if (code !== 0) notes.push(`ffmpeg ${exitText(code)}${rec.ffmpegError ? `: ${rec.ffmpegError.trim()}` : ''}`);
  const length = cut || rec.exitedEarly ? '' : `${seconds.toFixed(1)}s, `;
  const steps = writeSteps(rec, seconds);
  const stepsLine = !steps ? '' : steps.error ? `\nIts steps were not saved: ${steps.error}` : `\nSteps: ${steps.file} (${steps.count}; when each command ran, and where)`;
  return `Saved: ${rec.file} (${length}${rec.size.width}x${rec.size.height}, ${sizeText(saved)})${notes.length ? `\n${notes.join('; ')}` : ''}${stepsLine}`;
}

// The steps: when each command the REPL ran on a recording tab began and ended, in the video's own
// seconds, and the element or point it acted on in the video's pixels, saved next to the video for
// whoever edits it (a caption or a cut at a step, say). Only that: watch is the log of what happened.

// The video's clock: frames are written against the wall clock since the first, less those dropped.
function videoTime(rec) {
  return rec.firstFrameAt === null ? 0 : Math.max(0, (Date.now() - rec.firstFrameAt) / 1000 - rec.dropped / FPS);
}

// What a step is, for its line: the command and what it acts on, never what it types or chooses, the
// code it runs or the URL it goes to, which can hold a password or a token. A steps file goes where the
// video goes, and the video shows a password as dots.
const WHOLE = new Set(['click', 'dblclick', 'hover', 'check', 'uncheck', 'mousemove', 'mouseclick', 'mousedown', 'mouseup', 'mousewheel']);
const TARGET_FIRST = new Set(['fill', 'type', 'select', 'press', 'upload']);
function stepLabel(cmd, args) {
  if (WHOLE.has(cmd)) {
    const words = args.replace(/\s+--modifiers=\S+/, '').trim();
    // An element's selector as written, without the quotes it needed on the command line (click's button after it).
    const parsed = /^mouse/.test(cmd) ? null : splitSelector(words);
    return `${cmd} ${parsed ? [parsed.word, parsed.rest].filter(Boolean).join(' ') : words}`.trim();
  }
  // A toast's text is what it said in the video, for whoever edits it.
  if (cmd === 'toast') return `toast ${args.trim()}`.trim();
  // A highlight's selector, or off: which box came and went, without its style.
  if (cmd === 'highlight') return `highlight ${args.replace(/\s*--style=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/, '').trim()}`.trim();
  if (!TARGET_FIRST.has(cmd)) return cmd;
  const rest = cmd === 'type' ? args.replace(/^\s*--delay(?:=|\s+)\S*\s*/, '') : args;
  const parsed = splitSelector(rest);
  // type and press with one word act on the focused element: the word is the text or the key.
  return parsed && parsed.rest !== undefined ? `${cmd} ${parsed.word}` : cmd;
}

// The recording that keeps its steps (record on --steps), if the tab has one.
function stepsOf(p) {
  const rec = recordingOf(p);
  return rec?.keepSteps ? rec : null;
}

function stepStarted(p, command) {
  const rec = stepsOf(p);
  if (!rec || rec.finishing) return null;
  // After the page changed size, its frames are fitted into the first size, so its pixels are not the video's.
  rec.step = { rec, t0: videoTime(rec), t1: null, command, box: null, point: null, offSize: rec.resizedAt !== null, failed: false };
  rec.steps.push(rec.step);
  return rec.step;
}

function stepEnded(step, failed) {
  if (!step) return;
  step.t1 = videoTime(step.rec);
  step.failed = failed;
  if (step.rec.step === step) step.rec.step = null;
}

// The element (box) or point the running step acts on, in CSS pixels.
function stepTarget(p, box, point) {
  const rec = stepsOf(p);
  if (!rec?.step) return;
  const scaled = o => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * rec.scale)]));
  rec.step.box = scaled(box);
  rec.step.point = scaled(point);
}

// Where the cursor went (cursor on), and when: a line of its own, not a command's step.
function cursorStep(p, what, point, ms) {
  const rec = stepsOf(p);
  if (!rec || rec.finishing) return;
  const t0 = videoTime(rec);
  const scaled = Math.round(point.x * rec.scale);
  rec.steps.push({ rec, t0, t1: t0 + ms / 1000, command: what.replace(/-?\d+(?:\.\d+)?/g, n => String(Math.round(Number(n) * rec.scale))), box: null, point: { x: scaled, y: Math.round(point.y * rec.scale) }, offSize: rec.resizedAt !== null, failed: false });
}

// Run by record off before it ends a recording, each with the recorded tab: for what the video must
// still show first. Registered by the modules that know, which record cannot require.
const beforeEnding = [];
function beforeRecordingEnds(wait) {
  beforeEnding.push(wait);
}

// The pause after an action on a recording tab, for its result to be seen (record on --pause), and
// after a command that drew something to be seen (pauseToShow), as highlight does. After the command's
// step ends, as an action's does.
const ACTIONS = new Set([...WHOLE, ...TARGET_FIRST]);
function pauseToShow(p) {
  const rec = recordingOf(p);
  if (rec) rec.showing = true;
}
async function pauseAfter(p, cmd) {
  const rec = p && !p.isClosed() ? recordingOf(p) : null;
  if (!rec) return;
  const show = rec.showing;
  rec.showing = false;
  if (!rec.finishing && rec.pacing.pause && (show || ACTIONS.has(cmd))) await sleep(rec.pacing.pause);
}

function stepsPath(file) {
  return file.replace(/\.[^./]+$/, '') + '.steps.txt';
}

// One line a step: t0 t1, then x y w h of its element (a point is x y 0 0; none, or not in the video's
// pixels, is - - - -), then the command. Plain words, for a shell script to read.
function writeSteps(rec, seconds) {
  if (!rec.keepSteps || !rec.steps.length) return null;
  const file = stepsPath(rec.file);
  const lines = [
    `# pw-repl record steps, for a video of ${rec.size.width}x${rec.size.height}, ${seconds.toFixed(2)}s long`,
    '# t0 t1: when the command began and ended, in seconds into the video',
    '# x y w h: its element in the video\'s pixels (a point: w and h are 0; none: -)',
    '# (cursor from X Y): the cursor (cursor on) glided from X Y to x y between t0 and t1',
    '# (page): the tab went to a new page, loaded or routed to by a single-page app',
    ...(rec.resizedAt !== null ? [`# the page changed size at ${rec.resizedAt.toFixed(2)}s: boxes after it are left out`] : []),
  ];
  for (const s of rec.steps) {
    const where = s.offSize ? null : s.box || (s.point && { x: s.point.x, y: s.point.y, width: 0, height: 0 });
    const xywh = where ? `${where.x} ${where.y} ${where.width} ${where.height}` : '- - - -';
    lines.push(`${s.t0.toFixed(2)} ${(s.t1 ?? videoTime(rec)).toFixed(2)} ${xywh} ${s.command}${s.failed ? '  # failed' : ''}`);
  }
  try {
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    return { file, error: error.code === 'EEXIST' ? `${file} already exists` : error.message };
  }
  rec.stepsFile = file;
  return { file, count: rec.steps.length };
}

const TAB_CLOSED = 'Its tab closed, which ended it';

// What became of a recording that tab close ended by closing its tab, for it to say.
async function endedByTabClose(rec) {
  const text = await finishRecording(rec, TAB_CLOSED);
  const last = lastEnded.get(rec.owner ?? null);
  if (last?.text === text) last.seen = true;
  return text;
}

// Ends every recording, as the REPL stops, and says in the pane and the log what each saved, and
// what became of any that ended by itself that record has not shown since.
async function finishAll() {
  for (const last of lastEnded.values()) if (!last.seen) out.log(`${ENDED_UNSEEN}: ${last.text.replace(/\n/g, '; ')}`);
  // One line each, for stop to find in the log.
  await Promise.all(recordingPages().map(p => finishRecording(recordingOf(p), STOPPED_RECORDING, { shuttingDown: true }).then(text => out.log(text.replace(/\n/g, '; ')), () => {})));
}

onShutdown(finishAll);

// The pacing options record on was given, where they differ from the defaults.
function pacingText(pacing) {
  const changed = Object.keys(PACING).filter(k => pacing[k] !== PACING[k]).map(k => `--${k}=${pacing[k]}`);
  return changed.length ? `, ${changed.join(' ')}` : '';
}

function statusText(p) {
  const rec = recordingOf(p);
  if (!rec) {
    const last = lastEnded.get(state.client ?? null);
    if (last) last.seen = true;
    return `The selected tab is not being recorded; record on starts it.${last ? `\nYour last recording, ended at ${clock(last.at)}: ${last.text}` : ''}`;
  }
  const since = ((Date.now() - (rec.firstFrameAt || rec.startedAt)) / 1000).toFixed(1);
  const size = rec.size ? `, ${rec.size.width}x${rec.size.height}` : ', no frame yet';
  const resized = rec.resizedAt !== null ? `; the page changed size at ${rec.resizedAt.toFixed(1)}s and is fitted into the first size (help record --all)` : '';
  return `Recording the selected tab to ${rec.file} since ${clock(rec.startedAt)} (${since}s${size})${rec.owner ? `, by ${rec.owner}` : ''}${rec.keepSteps ? ', with its steps' : ''}${pacingText(rec.pacing)}${resized}; record off stops it and saves the file.`;
}

// A file word, as given or as playwright-cli's --filename=<file> (or --filename <file>); any other
// option is refused, never taken for a file name.
function fileWords(words, usage) {
  const files = [];
  const rest = [];
  let steps = false;
  const pacing = {};
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const timing = /^--(pause|lead|tail)(?:=(.*))?$/.exec(word);
    if (word === '--steps') steps = true;
    else if (timing) {
      if (!/^\d+$/.test(timing[2] ?? '') || Number(timing[2]) > 10000) throw new Error(`record on --${timing[1]}=<ms> takes milliseconds, from 0 to 10000 (default ${PACING[timing[1]]})`);
      pacing[timing[1]] = Number(timing[2]);
    }
    else if (word.startsWith('--filename=') && word.length > 11) files.push(word.slice(11));
    else if (word === '--filename' && words[i + 1]) files.push(words[++i]);
    else if (/^--(?:mp4|webm)$/.test(word)) throw new Error(`record takes no ${word}: the file's ending picks the format, as in record on clip.${word.slice(2)}`);
    // playwright-cli's video-start --size: here the video is the page's size.
    else if (/^--size(?:=|$)/.test(word)) throw new Error(`record takes no --size: the video is the page's size; set it first with viewport <width>x<height>`);
    else if (word.startsWith('-')) throw new Error(`record takes no ${word}. ${usage}`);
    else if (/^\d+$/.test(word)) rest.push(word);
    else files.push(word);
  }
  if (files.length > 1) throw new Error(`record takes one file, and ${files.map(f => `"${f}"`).join(' and ')} are two: quote a file name with spaces in it. ${usage}`);
  return { file: files.length ? path.resolve(files[0]) : null, rest, steps, pacing };
}

function checkFile(file, format) {
  const ext = path.extname(file).toLowerCase().slice(1);
  if (!FORMATS[ext]) throw new Error(`A recording is a .webm or .mp4 file, not ${path.basename(file)}`);
  if (format && ext !== format) throw new Error(`This recording is ${format === 'webm' ? 'WebM' : 'MP4'}: name it .${format}, not ${path.basename(file)}`);
  if (fs.existsSync(file)) throw new Error(`Recording already exists: ${file}`);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`No folder ${path.dirname(file)} to save ${path.basename(file)} in`);
  try { fs.accessSync(path.dirname(file), fs.constants.W_OK); } catch { throw new Error(`Cannot write in ${path.dirname(file)} to save ${path.basename(file)} there`); }
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
    // A file may be quoted, with spaces in it.
    const words = shellWords(args);
    const usage = `Usage: record [on [file.webm|file.mp4] [seconds] [--steps] [--pause=<ms>] [--lead=<ms>] [--tail=<ms>] | off [file]] (seconds from 1 to ${MAX_SECONDS})`;
    if (!words.length) {
      await Promise.allSettled([...(saving.get(state.client ?? null) || [])]);
      out.log(statusText(state.page));
      return;
    }
    const [what, ...rest] = words;
    if (what !== 'on' && what !== 'off') throw new Error(usage);
    // record on its own, and record off, work with no tab selected, as after the recorded tab closed.
    const noTab = !state.page || state.page.isClosed();
    if (noTab && what === 'on') throw new Error(NO_TAB);
    // A file given is relative to the REPL's folder; pw-repl send makes it the sender's.
    const { file: named, rest: numbers, steps, pacing } = fileWords(rest, usage);
    if (what === 'off') {
      if (Object.keys(pacing).length) throw new Error(`--${Object.keys(pacing)[0]} goes on record on`);
      if (steps) throw new Error('--steps goes on record on, which notes each step from the start: record off, then record on <file> --steps for a take with its steps');
      if (numbers.length) throw new Error(usage);
      const rec = noTab ? null : recordingOf(state.page);
      if (!rec) {
        await Promise.allSettled([...(saving.get(state.client ?? null) || [])]);
        // A recording that ended by itself and saved nothing fails record off, once, as it would
        // have had record off ended it: its exit status is what an agent checks.
        const last = lastEnded.get(state.client ?? null);
        const text = statusText(state.page);
        if (last?.failed && !last.reported) { last.reported = true; throw new Error(text); }
        out.log(text);
        return;
      }
      // Its own name again (named at both ends, as playwright-cli habits have it) is no rename.
      const rename = named && named !== rec.file ? named : null;
      // Checked first, so a name that cannot be used leaves it recording, and says so.
      if (rename) {
        try { checkFile(rename, rec.format); } catch (error) { throw new Error(`${error.message}; still recording to ${rec.file}`); }
      }
      // Any client with the tab selected stops it, as it turns off any mode; both are told whose it was.
      const other = (rec.owner ?? null) !== (state.client ?? null);
      const clientName = c => c ?? 'the unnamed client';
      // What must be seen before the end (a toast's read time), then the tail: still page after the last
      // action. Only record off has them; the seconds limit is a hard stop.
      if (!rec.finishing) for (const wait of beforeEnding) await wait(state.page);
      if (!rec.finishing) await sleep(rec.pacing.tail);
      const text = await finishRecording(rec, other ? `${clientName(state.client)}'s record off ended ${clientName(rec.owner)}'s recording` : null);
      if (rec.failed) { lastEnded.get(rec.owner ?? null).reported = true; throw new Error(text); }
      if (!rename || !fs.existsSync(rec.file)) { out.log(text); return; }
      try {
        moveRecording(rec.file, rename);
      } catch (error) {
        throw new Error(`${text}\nIt could not be renamed to ${rename} (${error.message}), so it stays where it was saved`);
      }
      // Its steps go with it, unless a file has the new name already.
      let renamed = t => t.split(rec.file).join(rename);
      if (rec.stepsFile && !fs.existsSync(stepsPath(rename))) {
        try {
          moveRecording(rec.stepsFile, stepsPath(rename));
          const before = renamed;
          renamed = t => before(t.split(rec.stepsFile).join(stepsPath(rename)));
        } catch {}
      }
      const last = lastEnded.get(rec.owner ?? null);
      if (last) last.text = renamed(last.text);
      out.log(renamed(text));
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
    let rec;
    try {
      rec = await startRecording(state.page, file, seconds, format, steps, { ...PACING, ...pacing });
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    }
    // An ffmpeg that stopped as it started (bad arguments, an encoder that failed) has ended it
    // already, and record on says so instead of a notice.
    if (rec.finishing) {
      const text = await rec.finishing;
      if (rec.failed) { lastEnded.get(rec.owner ?? null).reported = true; throw new Error(text); }
      out.log(text);
      return;
    }
    rec.starting = false;
    // The lead: still page before the first action, counted from the first frame.
    const until = Date.now() + 2000;
    while (rec.firstFrameAt === null && !rec.finishing && Date.now() < until) await sleep(20);
    if (rec.firstFrameAt !== null && !rec.finishing) await sleep(Math.max(0, rec.pacing.lead - (Date.now() - rec.firstFrameAt)));
    const limit = numbers.length ? `for ${seconds}s` : `until record off (at most ${MAX_SECONDS / 60} minutes)`;
    out.log(`Recording the selected tab to ${file} ${limit}${steps ? ', with its steps' : ''}${pacingText(rec.pacing)}; record off stops it and saves the file.`);
  },
};

module.exports = { commands, recordingOf, beforeRecordingEnds, stepsOf, pauseAfter, pauseToShow, finishRecording, endedByTabClose, findFfmpeg, jpegSize, stepStarted, stepEnded, stepTarget, cursorStep, stepLabel };
