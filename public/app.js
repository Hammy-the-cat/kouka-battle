// ===== Utility =====
const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, youId = null, currentPIN = null;
let isHost = false;
let reconnectTimer = null, reconnectDelay = 1000;
let lastJoinInfo = null; // { pin, name, headcount }
let noiseFloor = 0.02; // default relative
let headcount = 30;

let audioCtx, analyser, micSource, timeArray;
let running = false, startAt = 0, endAt = 0;
let oscNode = null;
let guideAudio = null;
let guideAudioUnlocked = false;
let clipCount = 0, sampleCount = 0;
let rmsMax = 0, peakMax = 0;
let pitchHz = 0;
let lastFrameVal = 0;
let varianceSum = 0;
let frameN = 0;
let latestState = null;
let currentRoundLabel = null;

function setStatus(msg) {
  const el = qs('#status'); if (el) el.textContent = msg;
  const top = qs('#conn-top'); if (top) top.textContent = msg;
}

// ===== Toasts =====
function ensureToastContainer() {
  let c = qs('#toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    document.body.appendChild(c);
  }
  return c;
}
function showToast(text, type = 'info', ms = 2500) {
  const c = ensureToastContainer();
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = text;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 160ms ease';
    setTimeout(() => t.remove(), 180);
  }, ms);
}

// ===== WebSocket =====
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'room_created': {
        currentPIN = msg.pin; isHost = true;
        qs('#pin-label').textContent = currentPIN;
        qs('#pin-top').textContent = currentPIN;
        qs('#you-label').textContent = 'Host';
        showLobby(msg.state);
        updateShareSection();
        break;
      }
      case 'joined': {
        currentPIN = msg.pin; youId = msg.you; isHost = false;
        qs('#pin-label').textContent = currentPIN;
        qs('#pin-top').textContent = currentPIN;
        qs('#you-label').textContent = msg.you;
        showLobby(msg.state);
        updateShareSection();
        break;
      }
      case 'state': {
        showLobby(msg.state);
        updateShareSection();
        break;
      }
      case 'round_start': {
        onRoundStart(msg.round);
        break;
      }
      case 'leaderboard': {
        renderLeaderboard(msg.leaderboard);
        break;
      }
      case 'error': {
        alert(msg.message);
        break;
      }
    }
  };

  ws.onclose = () => {
    setStatus('未接続（再接続中…）');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(10000, reconnectDelay * 2);
      connectWS();
    }, reconnectDelay);
  };

  ws.onopen = () => {
    setStatus('接続中…OK');
    reconnectDelay = 1000;
    try {
      if (lastJoinInfo && !isHost) {
        ws.send(JSON.stringify({ type: 'join_room', pin: lastJoinInfo.pin, name: lastJoinInfo.name, headcount: lastJoinInfo.headcount }));
      } else if (currentPIN) {
        ws.send(JSON.stringify({ type: 'request_state' }));
      }
    } catch {}
  };
}
connectWS();

// ===== Views =====
function show(el) { if (el) el.style.display = ''; }
function hide(el) { if (el) el.style.display = 'none'; }

function showLobby(state) {
  hide(qs('#view-welcome'));
  show(qs('#view-lobby'));
  latestState = state || null;
  renderPlayers(state?.players || []);
  const amHost = isHost || !!state?.players?.find((p) => p.id === youId && p.isHost);
  qs('#host-panel').style.display = amHost ? '' : 'none';
  // Update topbar round label if exists
  if (state?.rounds?.length) {
    const r = state.rounds[state.rounds.length - 1];
    qs('#round-top').textContent = r.label || '進行中';
  }
  // Enable start only when all ready
  if (amHost) {
    const players = state?.players || [];
    const allReady = players.length > 0 && players.every(p => p.ready);
    const btn = qs('#btn-start');
    const hint = qs('#start-hint');
    if (btn) btn.disabled = !allReady;
    if (hint) hint.textContent = allReady ? '開始できます。' : '全員が「準備OK」になると開始できます。';
  }
}

function renderPlayers(players) {
  const tbl = qs('#players');
  if (!tbl) return;
  const head = '<tr><th>名前</th><th>人数</th><th>準備</th><th>役割</th></tr>';
  const rows = players.map((p) => `
    <tr>
      <td>${p.name}</td>
      <td>${p.headcount}</td>
      <td><span class="badge ${p.ready ? 'ready' : 'waiting'}">${p.ready ? '準備OK' : '待機中'}</span></td>
      <td>${p.isHost ? '主催' : '教室'}</td>
    </tr>`).join('');
  tbl.innerHTML = head + rows;
}

// ===== Events =====
qs('#btn-create').onclick = () => {
  const name = qs('#host-name').value || 'Host';
  const hc = Number(qs('#host-headcount').value || 30);
  headcount = hc; isHost = true;
  ws.send(JSON.stringify({ type: 'create_room', name, headcount: hc }));
};

qs('#btn-join').onclick = () => {
  const pin = qs('#join-pin').value.trim();
  const name = (qs('#join-name').value || '教室').trim();
  const hc = Number(qs('#join-headcount').value || 30);
  headcount = hc; isHost = false;
  ws.send(JSON.stringify({ type: 'join_room', pin, name, headcount: hc }));
  youId = 'you';
  lastJoinInfo = { pin, name, headcount: hc };
};

qs('#btn-calibrate').onclick = async () => {
  await ensureMic();
  setStatus('静音キャリブ中…');
  const sec = 5;
  const end = performance.now() + sec * 1000;
  let sum = 0, n = 0;
  while (performance.now() < end) {
    const { rms } = getRMS();
    sum += rms; n++;
    await sleep(16);
  }
  noiseFloor = Math.min(0.2, (sum / Math.max(1, n)) * 1.2);
  qs('#calib-result').textContent = `noiseFloor ≈ ${noiseFloor.toFixed(3)}`;
  setStatus('キャリブ完了');
};

qs('#btn-ready').onclick = () => {
  ws.send(JSON.stringify({ type: 'set_ready', ready: true }));
};

qs('#btn-save-headcount').onclick = () => {
  const v = Number(qs('#input-headcount').value || 30);
  headcount = v;
  ws.send(JSON.stringify({ type: 'update_player', headcount: v }));
};

qs('#btn-start').onclick = () => {
  const label = qs('#round-label').value || 'ラウンド';
  const seconds = Math.max(5, Math.min(60, Number(qs('#round-seconds').value || 10)));
  const useOsc = !!qs('#opt-osc').checked;
  ws.send(JSON.stringify({
    type: 'start_round',
    label,
    delayMs: 3000,
    options: { seconds, useOsc, targetHz: 220 }
  }));
};

// ===== Audio / Metrics =====
async function ensureMic() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  timeArray = new Float32Array(analyser.fftSize);
  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(analyser);
}

function getRMS() {
  analyser.getFloatTimeDomainData(timeArray);
  let rms = 0, pk = 0, clips = 0;
  for (let i = 0; i < timeArray.length; i++) {
    const v = timeArray[i];
    rms += v * v;
    const a = Math.abs(v);
    if (a > pk) pk = a;
    if (a > 0.98) clips++;
  }
  rms = Math.sqrt(rms / timeArray.length);
  const relRms = Math.max(0, (rms - noiseFloor) / (1 - noiseFloor));
  const relPk = Math.max(0, (pk - noiseFloor) / (1 - noiseFloor));
  return { rms, pk, relRms, relPk, clips };
}

// Simple autocorrelation-based pitch estimator
function estimatePitch(sampleRate = 44100) {
  analyser.getFloatTimeDomainData(timeArray);
  let SIZE = timeArray.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += timeArray[i] * timeArray[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return 0;
  let r1 = 0, r2 = SIZE - 1, thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(timeArray[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(timeArray[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  SIZE = r2 - r1;
  const buf = timeArray.slice(r1, r2);
  const c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) {
    for (let j = 0; j < SIZE - i; j++) c[i] += buf[j] * buf[j + i];
  }
  let d = 0; while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < SIZE; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  let T0 = maxpos;
  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);
  const freq = sampleRate / T0;
  if (freq < 60 || freq > 1000) return 0;
  return freq;
}

function centsDiff(freq, ref = 220) {
  if (!freq || !ref) return 0;
  return 1200 * Math.log2(freq / ref);
}

// ===== Round execution =====
async function onRoundStart(round) {
  show(qs('#view-round'));
  hide(qs('#view-results'));
  qs('#round-title').textContent = `${round.label}（${round.options.seconds}s）`;
  qs('#round-top').textContent = round.label || '進行中';

  await ensureMic();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Guide tone
  const useOsc = !!round.options.useOsc;
  const targetHz = round.options.targetHz || 220;

  // Optional local audio file
  const fileInput = qs('#opt-file');
  guideAudio = null;
  if (fileInput?.files?.[0]) {
    const url = URL.createObjectURL(fileInput.files[0]);
    const a = new Audio(url);
    a.loop = true;
    a.volume = 0.6;
    guideAudio = a;
  }

  // Ensure canvas fits container (responsive)
  const canvas = qs('#wave');
  const resizeCanvas = () => { try { canvas.width = Math.max(300, canvas.clientWidth || 1000); } catch {} };
  resizeCanvas();
  const onResize = () => resizeCanvas();
  window.addEventListener('resize', onResize);

  // Countdown until start
  startAt = round.startAt;
  const badge = qs('#timer');
  let waitMs = Math.max(0, startAt - Date.now());
  const overlay = qs('#countdown-overlay');
  const overlayTxt = qs('#overlay-count');
  overlay.style.display = 'grid';
  while (waitMs > 0) {
    const s = Math.ceil(waitMs / 1000);
    badge.textContent = `開始まで ${s}`;
    overlayTxt.textContent = s;
    await sleep(200);
    waitMs = Math.max(0, startAt - Date.now());
  }
  badge.textContent = `${round.options.seconds}`;
  overlay.style.display = 'none';

  // Start
  running = true;
  clipCount = 0; sampleCount = 0; rmsMax = 0; peakMax = 0; varianceSum = 0; frameN = 0; lastFrameVal = 0; pitchHz = 0;

  if (useOsc) {
    oscNode = audioCtx.createOscillator();
    oscNode.type = 'sine';
    oscNode.frequency.value = targetHz;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.1;
    oscNode.connect(gain).connect(audioCtx.destination);
    oscNode.start();
  }
  if (guideAudio) {
    try {
      guideAudio.currentTime = 0;
      await guideAudio.play();
    } catch (e) {
      showToast('ガイド音源の再生に失敗しました（自動再生制限の可能性）', 'warn');
      if (!useOsc) {
        // Fallback to oscillator if not enabled
        try {
          oscNode = audioCtx.createOscillator();
          oscNode.type = 'sine';
          oscNode.frequency.value = targetHz;
          const gain = audioCtx.createGain();
          gain.gain.value = 0.08;
          oscNode.connect(gain).connect(audioCtx.destination);
          oscNode.start();
          showToast('ガイド音（発振）に切替えました', 'info');
        } catch {}
      }
    }
  }

  const durMs = (round.options.seconds || 10) * 1000;
  endAt = startAt + durMs;
  drawLoop(audioCtx.sampleRate, targetHz);

  // Timer
  for (;;) {
    const left = Math.max(0, endAt - Date.now());
    qs('#timer').textContent = (left / 1000).toFixed(1);
    if (left <= 0) break;
    await sleep(100);
  }

  running = false;
  if (oscNode) { try { oscNode.stop(); } catch {} oscNode.disconnect(); oscNode = null; }
  if (guideAudio) { try { guideAudio.pause(); } catch {} }
  window.removeEventListener('resize', onResize);
  qs('#round-top').textContent = '--';

  // Calculate metrics
  const rmsScore = Math.max(0, (rmsMax - noiseFloor) / (1 - noiseFloor));
  const peakScore = Math.max(0, (peakMax - noiseFloor) / (1 - noiseFloor));
  const clipRate = sampleCount ? (clipCount / sampleCount) : 0;
  const loud = (rmsScore * 0.7 + peakScore * 0.3) * 40; // 0-40

  const unityRaw = 1 - Math.min(1, Math.sqrt(Math.max(0, varianceSum / Math.max(1, frameN))) * 3);
  const unity = Math.max(0, unityRaw) * 25; // 0-25

  const cents = Math.abs(centsDiff(pitchHz, targetHz));
  const pitch = Math.max(0, 1 - Math.min(1, cents / 50)) * 25; // 0-25 within ±50¢

  const adj = Math.max(-10, -clipRate * 40);
  const totalRaw = loud + unity + pitch + adj;
  const total = Math.max(0, Math.min(100, totalRaw * (30 / Math.max(1, headcount))));

  // Update UI
  qs('#rms-val').textContent = rmsMax.toFixed(3);
  qs('#peak-val').textContent = peakMax.toFixed(3);
  qs('#clip-val').textContent = `${(clipRate * 100).toFixed(1)}%`;
  qs('#pitch-val').textContent = pitchHz ? pitchHz.toFixed(1) : '-';
  qs('#cents-val').textContent = isFinite(cents) ? cents.toFixed(1) : '-';
  qs('#norm-val').textContent = `/ ${headcount} 人`;

  // Submit
  ws.send(JSON.stringify({
    type: 'score_submit',
    loud: Number(loud.toFixed(2)),
    unity: Number(unity.toFixed(2)),
    pitch: Number(pitch.toFixed(2)),
    clipRate: Number(clipRate.toFixed(4)),
    total: Number(total.toFixed(2))
  }));
}

function drawLoop(sampleRate, targetHz) {
  const canvas = qs('#wave');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  (function loop() {
    if (!running) return;
    const { rms, pk, relRms, relPk, clips } = getRMS();
    pitchHz = estimatePitch(sampleRate);
    const cents = centsDiff(pitchHz, targetHz);

    rmsMax = Math.max(rmsMax, rms);
    peakMax = Math.max(peakMax, pk);
    clipCount += clips;
    sampleCount += 1;
    const val = relRms;
    varianceSum += Math.pow(val - lastFrameVal, 2);
    lastFrameVal = val;
    frameN++;

    // UI
    qs('#meter-bar').style.width = `${Math.min(100, relRms * 100)}%`;
    qs('#rms-val').textContent = rms.toFixed(3);
    qs('#peak-val').textContent = pk.toFixed(3);
    qs('#pitch-val').textContent = pitchHz ? pitchHz.toFixed(1) : '-';
    qs('#cents-val').textContent = isFinite(cents) ? cents.toFixed(1) : '-';

    // Wave render
    analyser.getFloatTimeDomainData(timeArray);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#7aa2ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < timeArray.length; i++) {
      const x = (i / timeArray.length) * W;
      const y = H / 2 + timeArray[i] * H * 0.45;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    requestAnimationFrame(loop);
  })();
}

// ===== Leaderboard =====
function renderLeaderboard(items = []) {
  show(qs('#view-results'));
  const tbl = qs('#leaderboard');
  tbl.innerHTML = `
    <tr>
      <th>#</th><th>教室</th><th>合計</th><th>声量</th><th>まとまり</th><th>音程</th><th>クリップ率</th>
    </tr>` +
    items.map((e, i) => {
      const medal = i===0 ? '🥇' : i===1 ? '🥈' : i===2 ? '🥉' : '';
      return `
      <tr>
        <td>${medal || (i + 1)}</td>
        <td>${e.name}</td>
        <td>${e.score.toFixed(2)}</td>
        <td>${e.metrics.loud.toFixed(2)}</td>
        <td>${e.metrics.unity.toFixed(2)}</td>
        <td>${e.metrics.pitch.toFixed(2)}</td>
        <td>${(e.metrics.clipRate * 100).toFixed(1)}%</td>
      </tr>`;
    }).join('');
}

// ===== Host share (QR/link) =====
function updateShareSection() {
  const share = qs('#host-share');
  const amHost = isHost || !!(youId && qsa('#players tr').some(() => false)); // isHost flag governs
  if (!currentPIN || !isHost) { share.style.display = 'none'; return; }
  share.style.display = '';
  const base = (window.PUBLIC_BASE_URL || location.origin);
  const joinURL = `${base}/join?pin=${encodeURIComponent(currentPIN)}`;
  const linkEl = qs('#join-link');
  linkEl.value = joinURL;
  const qr = qs('#qr-img');
  const qrAPI = 'https://chart.googleapis.com/chart?chs=240x240&cht=qr&choe=UTF-8&chl=' + encodeURIComponent(joinURL);
  const fb = qs('#qr-fallback');
  fb.style.display = 'none';
  qr.style.display = '';
  qr.onerror = () => { qr.style.display = 'none'; fb.style.display = ''; };
  qr.src = qrAPI;
}

qs('#btn-copy-link').onclick = async () => {
  const v = qs('#join-link').value;
  try {
    await navigator.clipboard.writeText(v);
    setStatus('リンクをコピーしました');
  } catch {
    setStatus('コピーに失敗しました');
  }
};
qs('#btn-open-link').onclick = () => {
  const v = qs('#join-link').value;
  try { window.open(v, '_blank', 'noopener'); } catch {}
};

// Hook: pre-fill PIN from URL and update share visibility whenever lobby shows
const _origShowLobby = showLobby;
showLobby = function (state) {
  _origShowLobby(state);
  const url = new URL(location.href);
  const qpin = url.searchParams.get('pin');
  if (qpin) { qs('#join-pin').value = qpin; }
  updateShareSection();
};

// ===== Enhance interactions after DOM ready =====
document.addEventListener('DOMContentLoaded', () => {
  // Replace blocking alerts with non-blocking toasts
  try { window.alert = (msg) => showToast(String(msg || 'エラー'), 'error'); } catch {}

  // Override join click with validation + inline error + toast
  const joinBtn = qs('#btn-join');
  if (joinBtn) {
    joinBtn.onclick = () => {
      const pinEl = qs('#join-pin');
      const errEl = qs('#join-error');
      const pin = pinEl.value.trim();
      const name = (qs('#join-name').value || '教室').trim();
      const hc = Number(qs('#join-headcount').value || 30);
      const ok = /^[0-9]{6}$/.test(pin);
      if (!ok) {
        if (errEl) { errEl.style.display = ''; errEl.textContent = 'PINは6桁の数字で入力してください'; }
        pinEl.focus();
        return;
      }
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      headcount = hc; isHost = false;
      ws.send(JSON.stringify({ type: 'join_room', pin, name, headcount: hc }));
      youId = 'you';
      lastJoinInfo = { pin, name, headcount: hc };
    };
  }

  // Override copy link to show toast feedback
  const copyBtn = qs('#btn-copy-link');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const v = qs('#join-link').value;
      try {
        await navigator.clipboard.writeText(v);
        setStatus('リンクをコピーしました');
        showToast('リンクをコピーしました', 'success');
      } catch {
        setStatus('コピーに失敗しました');
        showToast('コピーに失敗しました', 'error');
      }
    };
  }

  // File selector: preload and try to unlock playback on user gesture
  const fileEl = qs('#opt-file');
  const fileNameEl = qs('#guide-file-name');
  if (fileEl) {
    fileEl.addEventListener('change', async () => {
      guideAudioUnlocked = false;
      guideAudio = null;
      if (fileEl.files && fileEl.files[0]) {
        const f = fileEl.files[0];
        if (fileNameEl) fileNameEl.textContent = `選択中: ${f.name}`;
        try {
          const url = URL.createObjectURL(f);
          const a = new Audio(url);
          a.loop = true; a.volume = 0.6;
          guideAudio = a;
          // Try unlocking by quick play/pause (within user gesture of file selection)
          try { await a.play(); a.pause(); guideAudioUnlocked = true; showToast('ガイド音源を準備しました', 'success'); } catch {}
        } catch (e) {
          showToast('音源の準備に失敗しました', 'error');
        }
      } else {
        if (fileNameEl) fileNameEl.textContent = '';
      }
    });
  }

  // Test play button for guide audio
  const testBtn = qs('#btn-test-guide');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      try { if (audioCtx?.state === 'suspended') await audioCtx.resume(); } catch {}
      if (!guideAudio) { showToast('音源ファイルを選択してください', 'warn'); return; }
      try {
        guideAudio.currentTime = 0;
        await guideAudio.play();
        showToast('ガイド再生中', 'success');
        setTimeout(() => { try { guideAudio.pause(); } catch {} }, 1200);
      } catch (e) {
        showToast('再生がブロックされました（ページを一度タップしてから再試行）', 'error');
      }
    });
  }
});
