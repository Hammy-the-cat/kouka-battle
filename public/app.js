
// ===== Utility =====
const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let ws, youId = null, currentPIN = null, isHost = false;
let noiseFloor = 0.02; // default relative
let headcount = 30;

let audioCtx, analyser, micSource, dataArray, timeArray;
let running = false, startAt = 0, endAt = 0;
let oscNode = null;
let guideBuffer = null;
let clipCount = 0, sampleCount = 0;
let rmsMax = 0, peakMax = 0;
let pitchHz = 0;
let lastFrameVal = 0;
let varianceSum = 0;
let frameN = 0;

function setStatus(msg) { qs('#status').textContent = msg; }

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setStatus('接続中…OK');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'room_created') {
      currentPIN = msg.pin; isHost = true;
      qs('#pin-label').textContent = currentPIN;
      qs('#you-label').textContent = 'Host';
      showLobby(msg.state);
    }
    if (msg.type === 'joined') {
      currentPIN = msg.pin; youId = msg.you;
      qs('#pin-label').textContent = currentPIN;
      qs('#you-label').textContent = msg.you;
      showLobby(msg.state);
    }
    if (msg.type === 'state') { showLobby(msg.state); }
    if (msg.type === 'round_start') { onRoundStart(msg.round); }
    if (msg.type === 'leaderboard') { renderLeaderboard(msg.leaderboard); }
    if (msg.type === 'error') { alert(msg.message); }
  };
  ws.onclose = () => setStatus('未接続（ページを再読み込みしてください）');
}
connectWS();

// ===== Views =====
function show(el) { el.style.display = ''; }
function hide(el) { el.style.display = 'none'; }
function showLobby(state) {
  hide(qs('#view-welcome')); show(qs('#view-lobby'));
  renderPlayers(state?.players || []);
  qs('#host-panel').style.display = (state?.players?.find(p => p.isHost) ? '' : 'none');
  if (state?.players?.find(p => p.id === youId)?.isHost) {
    qs('#host-panel').style.display = '';
  }
}
function renderPlayers(players) {
  const tbl = qs('#players');
  tbl.innerHTML = `<tr><th>名前</th><th>人数</th><th>準備</th><th>役割</th></tr>` +
    players.map(p =>
      `<tr><td>${p.name}</td><td>${p.headcount}</td><td>${p.ready ? '✅' : ''}</td><td>${p.isHost ? '主催' : '教室'}</td></tr>`
    ).join('');
}

// ===== Events =====
qs('#btn-create').onclick = () => {
  const name = qs('#host-name').value || 'Host';
  const hc = Number(qs('#host-headcount').value || 30);
  headcount = hc;
  ws.send(JSON.stringify({ type: 'create_room', name, headcount: hc }));
};
qs('#btn-join').onclick = () => {
  const pin = qs('#join-pin').value.trim();
  const name = qs('#join-name').value.trim() || '教室';
  const hc = Number(qs('#join-headcount').value || 30);
  headcount = hc;
  ws.send(JSON.stringify({ type: 'join_room', pin, name, headcount: hc }));
  youId = 'you'; // will be overwritten on joined
};

qs('#btn-calibrate').onclick = async () => {
  await ensureMic();
  setStatus('静音キャリブ中…');
  const sec = 5;
  const end = performance.now() + sec*1000;
  let sum = 0, n = 0;
  while (performance.now() < end) {
    const r = getRMS();
    sum += r; n++;
    await sleep(16);
  }
  noiseFloor = Math.min(0.2, (sum/n) * 1.2); // add margin
  qs('#calib-result').textContent = `noiseFloor ≈ ${noiseFloor.toFixed(3)}`;
  setStatus('キャリブ完了');
};

qs('#btn-ready').onclick = () => {
  ws.send(JSON.stringify({ type: 'set_ready', ready: true }));
};
qs('#btn-save-headcount').onclick = () => {
  const hc = Number(qs('#input-headcount').value || 30);
  headcount = hc;
  ws.send(JSON.stringify({ type: 'update_player', headcount: hc }));
};

qs('#btn-start').onclick = () => {
  const label = qs('#round-label').value || 'ラウンド';
  const seconds = Number(qs('#round-seconds').value || 10);
  const useOsc = qs('#opt-osc').checked;
  const options = { seconds, useOsc, targetHz: 220 };
  ws.send(JSON.stringify({ type: 'start_round', label, options, delayMs: 3000 }));
};

// ===== Audio processing =====
async function ensureMic() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  micSource = audioCtx.createMediaStreamSource(stream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  const bufferLength = analyser.fftSize;
  dataArray = new Float32Array(bufferLength);
  timeArray = new Float32Array(bufferLength);

  micSource.connect(analyser);
}

function getRMS() {
  analyser.getFloatTimeDomainData(timeArray);
  let sum = 0, pk = 0, clips = 0;
  for (let i=0;i<timeArray.length;i++) {
    const v = timeArray[i];
    sum += v*v;
    if (Math.abs(v) > pk) pk = Math.abs(v);
    if (Math.abs(v) >= 0.98) clips++;
  }
  const rms = Math.sqrt(sum/timeArray.length);
  const relRms = Math.max(0, (rms - noiseFloor) / (1 - noiseFloor));
  const relPk  = Math.max(0, (pk - noiseFloor) / (1 - noiseFloor));
  return { rms, pk, relRms, relPk, clips };
}

// Simple autocorrelation-based pitch estimator
function estimatePitch(sampleRate=44100) {
  analyser.getFloatTimeDomainData(timeArray);
  // Autocorrelation
  let SIZE = timeArray.length;
  let rms = 0;
  for (let i=0;i<SIZE;i++) rms += timeArray[i]*timeArray[i];
  rms = Math.sqrt(rms/SIZE);
  if (rms < 0.01) return 0;
  let r1=0, r2=SIZE-1, thres = 0.2;
  for (let i=0;i<SIZE/2;i++) if (Math.abs(timeArray[i]) < thres) { r1=i; break; }
  for (let i=1;i<SIZE/2;i++) if (Math.abs(timeArray[SIZE-i]) < thres) { r2=SIZE-i; break; }
  SIZE = r2 - r1;
  const buf = timeArray.slice(r1, r2);
  const c = new Array(SIZE).fill(0);
  for (let i=0;i<SIZE;i++) {
    for (let j=0;j<SIZE-i;j++) c[i] = c[i] + buf[j]*buf[j+i];
  }
  let d = 0; while (c[d] > c[d+1]) d++;
  let maxval=-1, maxpos=-1;
  for (let i=d;i<SIZE;i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  let T0 = maxpos;
  // Parabolic interpolation
  const x1 = c[T0-1] || 0, x2 = c[T0], x3 = c[T0+1] || 0;
  const a = (x1 + x3 - 2*x2)/2;
  const b = (x3 - x1)/2;
  if (a) T0 = T0 - b/(2*a);
  const freq = sampleRate / T0;
  if (freq < 60 || freq > 1000) return 0;
  return freq;
}

function centsDiff(freq, ref=220) {
  if (!freq || !ref) return 0;
  return 1200 * Math.log2(freq/ref);
}

// ===== Round execution =====
async function onRoundStart(round) {
  show(qs('#view-round'));
  hide(qs('#view-results'));
  qs('#round-title').textContent = `${round.label}（${round.options.seconds}s）`;

  await ensureMic();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Guide tone
  const useOsc = !!round.options.useOsc;
  const targetHz = round.options.targetHz || 220;

  // Optional local file from input (each classroom can choose a local file)
  const fileInput = qs('#opt-file');
  if (fileInput?.files?.[0]) {
    const file = fileInput.files[0];
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.loop = false;
    audio.volume = 0.6;
    // We will start it on countdown end
    window._guideAudio = audio;
  } else {
    window._guideAudio = null;
  }

  // Countdown until startAt
  startAt = round.startAt;
  const now = Date.now();
  let waitMs = Math.max(0, startAt - now);
  const badge = qs('#timer');
  while (waitMs > 0) {
    const s = Math.ceil(waitMs/1000);
    badge.textContent = `開始まで ${s}`;
    await sleep(200);
    waitMs = Math.max(0, startAt - Date.now());
  }
  badge.textContent = `${round.options.seconds}`;

  // Start
  running = true;
  clipCount = 0; sampleCount = 0; rmsMax = 0; peakMax = 0; varianceSum = 0; frameN = 0;
  const sr = audioCtx.sampleRate;

  if (useOsc) {
    oscNode = audioCtx.createOscillator();
    oscNode.type = 'sine';
    oscNode.frequency.value = targetHz;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.1;
    oscNode.connect(gain).connect(audioCtx.destination);
    oscNode.start();
  }
  if (window._guideAudio) {
    try { window._guideAudio.currentTime = 0; window._guideAudio.play(); } catch {}
  }

  const durMs = (round.options.seconds || 10) * 1000;
  endAt = startAt + durMs;
  drawLoop(sr, targetHz);

  // Timer
  const Tstart = performance.now();
  for (;;) {
    const left = Math.max(0, endAt - Date.now());
    qs('#timer').textContent = (left/1000).toFixed(1);
    if (left <= 0) break;
    await sleep(100);
  }

  running = false;
  if (oscNode) { try { oscNode.stop(); } catch {} oscNode.disconnect(); oscNode = null; }
  if (window._guideAudio) { try { window._guideAudio.pause(); } catch {} }

  // Calculate metrics
  const rmsScore = Math.max(0, (rmsMax - noiseFloor) / (1 - noiseFloor));
  const peakScore = Math.max(0, (peakMax - noiseFloor) / (1 - noiseFloor));
  const clipRate = sampleCount ? (clipCount / sampleCount) : 0;
  const loud = (rmsScore*0.7 + peakScore*0.3) * 40; // 0-40

  const unityRaw = 1 - Math.min(1, Math.sqrt(Math.max(0, varianceSum/frameN)) * 3);
  const unity = Math.max(0, unityRaw) * 25; // 0-25

  const cents = Math.abs(centsDiff(pitchHz, targetHz));
  const pitchScore = Math.max(0, 1 - Math.min(1, cents/50)) * 25; // within ±50¢ gets near full
  const pitch = pitchScore;

  const adj = Math.max(-10, -clipRate*40); // simple penalty
  const totalRaw = loud + unity + pitch + adj;
  const total = Math.max(0, Math.min(100, totalRaw * (30/Math.max(1, headcount)))); // naive normalization by headcount

  // Update UI
  qs('#rms-val').textContent = rmsMax.toFixed(3);
  qs('#peak-val').textContent = peakMax.toFixed(3);
  qs('#clip-val').textContent = `${(clipRate*100).toFixed(1)}%`;
  qs('#pitch-val').textContent = pitchHz ? pitchHz.toFixed(1) : '-';
  qs('#cents-val').textContent = isFinite(cents) ? cents.toFixed(1) : '-';
  qs('#norm-val').textContent = `/ ${headcount} 人`;

  // Submit
  ws.send(JSON.stringify({
    type: 'score_submit',
    loud: Number((loud).toFixed(2)),
    unity: Number((unity).toFixed(2)),
    pitch: Number((pitch).toFixed(2)),
    clipRate: Number((clipRate).toFixed(4)),
    total: Number((total).toFixed(2))
  }));
}

function drawLoop(sampleRate, targetHz) {
  const ctx = qs('#wave').getContext('2d');
  const W = qs('#wave').width, H = qs('#wave').height;

  (function loop() {
    if (!running) return;
    const { rms, pk, relRms, relPk, clips } = getRMS();
    pitchHz = estimatePitch(sampleRate);
    const cents = centsDiff(pitchHz, targetHz);

    // Stats accumulation
    rmsMax = Math.max(rmsMax, rms);
    peakMax = Math.max(peakMax, pk);
    clipCount += clips;
    sampleCount += 1;
    // frame variance (smoothness proxy)
    const val = relRms;
    varianceSum += Math.pow(val - lastFrameVal, 2);
    lastFrameVal = val;
    frameN++;

    // UI
    qs('#meter-bar').style.width = `${Math.min(100, relRms*100)}%`;
    qs('#rms-val').textContent = rms.toFixed(3);
    qs('#peak-val').textContent = pk.toFixed(3);
    qs('#pitch-val').textContent = pitchHz ? pitchHz.toFixed(1) : '-';
    qs('#cents-val').textContent = isFinite(cents) ? cents.toFixed(1) : '-';

    // Wave render
    analyser.getFloatTimeDomainData(timeArray);
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle = '#7aa2ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i=0;i<timeArray.length;i++) {
      const x = i / timeArray.length * W;
      const y = H/2 + timeArray[i] * H*0.45;
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();

    requestAnimationFrame(loop);
  })();
}

// ===== Leaderboard =====
function renderLeaderboard(items=[]) {
  show(qs('#view-results'));
  const tbl = qs('#leaderboard');
  tbl.innerHTML = `<tr><th>#</th><th>教室</th><th>合計</th><th>声量</th><th>まとまり</th><th>音程</th><th>Clip率</th></tr>` +
    items.map((e,i)=>`<tr><td>${i+1}</td><td>${e.name}</td><td>${e.score.toFixed(2)}</td>
      <td>${e.metrics.loud.toFixed(2)}</td>
      <td>${e.metrics.unity.toFixed(2)}</td>
      <td>${e.metrics.pitch.toFixed(2)}</td>
      <td>${(e.metrics.clipRate*100).toFixed(1)}%</td></tr>`).join('');
}
