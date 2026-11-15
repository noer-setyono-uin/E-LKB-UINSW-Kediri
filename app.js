// ============================== STATE ==============================
let recognition = null;
let isRecording = false;
let transcriptBase = ''; // teks final (hasil ketik/rekam)

// ============================== HELPER ==============================
function $(id) { return document.getElementById(id); }

function todayStr() {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function setStatus(id, text, isError) {
  const el = $(id);
  el.textContent = text;
  el.className = 'status' + (isError ? ' error' : '');
}

// ============================== API (Apps Script) ==============================
function getSettings() {
  return {
    url: localStorage.getItem('lkb_api_url') || '',
    token: localStorage.getItem('lkb_api_token') || ''
  };
}

/**
 * Semua panggilan ke backend lewat POST text/plain (tanpa preflight CORS).
 * Backend membalas { ok: true, data } atau { ok: false, error }.
 */
async function api(action, payload = {}) {
  const { url, token } = getSettings();
  if (!url || !token) throw new Error('Isi URL & token di Pengaturan dulu.');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token, action, ...payload })
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Terjadi kesalahan di server.');
  return json.data;
}

// ============================== INIT ==============================
document.addEventListener('DOMContentLoaded', () => {
  $('tanggalInput').value = todayStr();
  $('monthInput').value = todayStr().slice(0, 7);

  $('btnSettings').addEventListener('click', () => $('settingsCard').classList.toggle('hidden'));
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnMic').addEventListener('click', toggleMic);
  $('btnSave').addEventListener('click', saveActivities);
  $('btnRefreshLogs').addEventListener('click', loadLogs);
  $('tanggalInput').addEventListener('change', loadLogs);
  $('btnGenerate').addEventListener('click', generateReport);
  $('narasiInput').addEventListener('input', e => { transcriptBase = e.target.value; });

  setupSpeech();

  const s = getSettings();
  $('apiUrl').value = s.url;
  $('apiToken').value = s.token;
  if (s.url && s.token) {
    loadProfile();
    loadLogs();
  } else {
    $('settingsCard').classList.remove('hidden');
    $('profileInfo').textContent = 'Belum terhubung — isi Pengaturan.';
  }
});

// ============================== PENGATURAN ==============================
function saveSettings() {
  const url = $('apiUrl').value.trim();
  const token = $('apiToken').value.trim();
  if (!url || !token) return setStatus('settingsStatus', 'URL dan token wajib diisi.', true);

  localStorage.setItem('lkb_api_url', url);
  localStorage.setItem('lkb_api_token', token);
  setStatus('settingsStatus', 'Tersimpan di browser ini.');
  loadProfile();
  loadLogs();
}

// ============================== PROFIL ==============================
async function loadProfile() {
  try {
    const p = await api('getProfile');
    $('profileInfo').textContent = p.nama + ' · NIP. ' + p.nip + (p.jabatan ? ' · ' + p.jabatan : '');
  } catch (err) {
    setStatus('profileInfo', 'Gagal memuat profil: ' + err.message, true);
  }
}

// ============================== REKAM SUARA (Web Speech API) ==============================
function setupSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $('btnMic').disabled = true;
    $('micStatus').textContent = 'Browser tidak mendukung rekam suara. Gunakan Chrome/Edge.';
    return;
  }
  recognition = new SR();
  recognition.lang = 'id-ID';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = event => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        transcriptBase += (transcriptBase ? ' ' : '') + text.trim();
      } else {
        interim += text;
      }
    }
    $('narasiInput').value = transcriptBase + (interim ? ' ' + interim : '');
  };

  recognition.onerror = event => {
    $('micStatus').textContent = 'Error mikrofon: ' + event.error;
    stopRecording();
  };

  recognition.onend = () => { if (isRecording) recognition.start(); }; // lanjut selama mode rekam
}

function toggleMic() {
  if (!recognition) return;
  if (isRecording) return stopRecording();

  transcriptBase = $('narasiInput').value;
  isRecording = true;
  recognition.start();
  $('btnMic').classList.add('recording');
  $('btnMic').textContent = '⏹ Berhenti Rekam';
  $('micStatus').textContent = 'Mendengarkan...';
}

function stopRecording() {
  isRecording = false;
  if (recognition) recognition.stop();
  $('btnMic').classList.remove('recording');
  $('btnMic').textContent = '🎤 Rekam Suara';
  $('micStatus').textContent = '';
}

// ============================== SIMPAN KEGIATAN ==============================
async function saveActivities() {
  const tanggal = $('tanggalInput').value;
  const narasi = $('narasiInput').value.trim();

  if (!tanggal) return setStatus('saveStatus', 'Pilih tanggal dulu.', true);
  if (!narasi) return setStatus('saveStatus', 'Ceritakan kegiatan Anda dulu.', true);
  if (isRecording) stopRecording();

  const btn = $('btnSave');
  btn.disabled = true;
  btn.textContent = 'Memproses dengan AI...';
  setStatus('saveStatus', '');

  try {
    const saved = await api('saveActivities', { tanggal, narasi });
    setStatus('saveStatus', saved.length + ' kegiatan berhasil disimpan.');
    $('narasiInput').value = '';
    transcriptBase = '';
    loadLogs();
  } catch (err) {
    setStatus('saveStatus', 'Gagal: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan & Proses dengan AI';
  }
}

// ============================== RIWAYAT HARIAN ==============================
async function loadLogs() {
  const listEl = $('logList');
  listEl.innerHTML = '<div class="empty-state">Memuat...</div>';
  try {
    renderLogs(await api('getLogs', { tanggal: $('tanggalInput').value }));
  } catch (err) {
    listEl.innerHTML = '<div class="empty-state">Gagal memuat: ' + escapeHtml(err.message) + '</div>';
  }
}

function renderLogs(logs) {
  const listEl = $('logList');
  if (!logs.length) {
    listEl.innerHTML = '<div class="empty-state">Belum ada kegiatan tercatat.</div>';
    return;
  }
  listEl.innerHTML = '';
  logs.forEach(log => {
    const div = document.createElement('div');
    div.className = 'log-item';
    div.innerHTML =
      '<span class="tag">' + escapeHtml(log.judulLaporan) + '</span>' +
      '<div>' + escapeHtml(log.deskripsi) + '</div>' +
      '<div class="muted">Jml: ' + escapeHtml(log.jml) + ' ' + escapeHtml(log.satuan) + '</div>' +
      '<a>Hapus</a>';
    div.querySelector('a').addEventListener('click', () => deleteLog(log.id));
    listEl.appendChild(div);
  });
}

async function deleteLog(id) {
  if (!confirm('Hapus kegiatan ini?')) return;
  try {
    await api('deleteLog', { id });
    loadLogs();
  } catch (err) {
    alert('Gagal hapus: ' + err.message);
  }
}

// ============================== LAPORAN BULANAN ==============================
async function generateReport() {
  const month = $('monthInput').value; // 'yyyy-MM'
  if (!month) return setStatus('reportStatus', 'Pilih bulan dulu.', true);

  const btn = $('btnGenerate');
  btn.disabled = true;
  btn.textContent = 'Membuat laporan...';
  setStatus('reportStatus', 'Menyusun laporan & PDF, mohon tunggu...');

  try {
    const res = await api('generateReport', { month });
    $('reportStatus').className = 'status';
    $('reportStatus').innerHTML = 'Laporan siap! <a href="' + encodeURI(res.pdfUrl) + '" target="_blank" rel="noopener">Buka / Unduh PDF</a>';
  } catch (err) {
    setStatus('reportStatus', 'Gagal: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buat Laporan PDF';
  }
}
