// =====================================================================
//  E-LKB — logika client
//  1) Ganti API_URL dengan URL Web App Apps Script Anda (berakhiran /exec).
//  2) APP_API_TOKEN: isi hanya jika Script Property APP_API_TOKEN diisi di backend.
//     (Nilai ini terlihat publik di file ini — ia hanya penghalang bot, bukan rahasia.)
// =====================================================================
const API_URL = 'GANTI_DENGAN_URL_WEB_APP_ANDA/exec';
const APP_API_TOKEN = '';

const TOKEN_KEY = 'lkb_token';
const AUTOSEND_KEY = 'lkb_autosend';
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const VIEWS = ['input', 'log', 'report', 'profile'];

// ============================== STATE ==============================
let token = '';
let profile = null;
let currentView = 'input';
let currentMode = 'ai';        // 'ai' | 'manual' (menu Input)
let categories = null;         // daftar Judul Laporan (diambil sekali)
let recognition = null;
let isRecording = false;
let transcriptBase = '';
let lastReport = null;         // { html, title } hasil pratinjau terakhir
const dayInfoCache = {};       // { 'yyyy-MM-dd': { libur, keterangan } }

// ============================== HELPER UMUM ==============================
function $(id) { return document.getElementById(id); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }
function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(str, delta) {
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function labelTanggal(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-').map(Number);
  return `${HARI[new Date(y, m - 1, d).getDay()]}, ${d} ${BULAN[m - 1]} ${y}`;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function setStatus(id, text, type) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'status !mt-0' + (type ? ' ' + type : '');
}

function setBusy(btn, busy, busyText) {
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyText;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

// ============================== NOTIFIKASI (SweetAlert2) ==============================
const swalBase = Swal.mixin({
  buttonsStyling: false,
  reverseButtons: true,
  customClass: {
    confirmButton: 'btn btn-primary mx-1',
    cancelButton: 'btn btn-outline mx-1',
    popup: '!rounded-2xl',
    title: '!text-lg'
  }
});

const Toast = Swal.mixin({
  toast: true, position: 'top', showConfirmButton: false, timer: 2800, timerProgressBar: true,
  customClass: { popup: '!rounded-xl' }
});

function toast(msg, icon) { Toast.fire({ icon: icon || 'success', title: msg }); }

function showLoading(title, text) {
  swalBase.fire({
    title: title, text: text || 'Mohon tunggu...', allowOutsideClick: false, allowEscapeKey: false,
    showConfirmButton: false, didOpen: () => Swal.showLoading()
  });
}
function hideLoading() { Swal.close(); }

function showError(title, err) {
  return swalBase.fire({ icon: 'error', title: title, text: (err && err.message) || String(err), confirmButtonText: 'Tutup' });
}

async function confirmBox(opts) {
  const r = await swalBase.fire({
    icon: opts.danger ? 'warning' : 'question',
    title: opts.title, text: opts.text,
    showCancelButton: true, confirmButtonText: opts.confirmText, cancelButtonText: 'Batal',
    customClass: {
      confirmButton: (opts.danger ? 'btn btn-danger-solid' : 'btn btn-primary') + ' mx-1',
      cancelButton: 'btn btn-outline mx-1',
      popup: '!rounded-2xl',
      title: '!text-lg'
    }
  });
  return r.isConfirmed;
}

// ============================== API ==============================
/**
 * Semua panggilan ke Apps Script lewat POST text/plain (tanpa preflight CORS):
 *   { appToken, token, action, payload }  ->  { ok, data } | { ok:false, error, code }
 * Token sesi dibuat server saat masuk; ID file dosen TIDAK pernah dikirim dari sini.
 */
async function api(action, payload = {}) {
  if (API_URL.indexOf('script.google.com') === -1) {
    throw new Error('API_URL di app.js belum diisi dengan URL Web App Anda.');
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ appToken: APP_API_TOKEN, token, action, payload })
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Respons server tidak valid. Pastikan deployment Apps Script sudah versi terbaru.');
  }
  if (!json.ok) {
    if (json.code === 'AUTH') handleSessionExpired(json.error);
    const err = new Error(json.error || 'Terjadi kesalahan di server.');
    err.code = json.code || '';
    throw err;
  }
  return json.data;
}

async function getCategories() {
  if (!categories) categories = await api('getCategories');
  return categories;
}

// ============================== SESI: MASUK / DAFTAR / KELUAR ==============================
function getSavedToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
}
function saveToken(t, remember) {
  clearToken();
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

function startSession(data, remember) {
  token = data.token;
  profile = data.profile;
  saveToken(token, remember);
  showApp();
}

async function onLogin(e) {
  e.preventDefault();
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) return setStatus('loginStatus', 'Isi email dan password.', 'error');

  const btn = $('btnLogin');
  setBusy(btn, true, 'Memeriksa...');
  setStatus('loginStatus', '');
  try {
    token = '';
    startSession(await api('login', { email, password }), $('rememberLogin').checked);
    $('loginPassword').value = '';
    toast('Selamat datang, ' + (profile.nama || ''));
  } catch (err) {
    setStatus('loginStatus', err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function onRegister(e) {
  e.preventDefault();
  const v = id => $(id).value.trim();
  if ($('regPassword').value !== $('regPassword2').value) {
    return setStatus('registerStatus', 'Konfirmasi password tidak sama.', 'error');
  }
  setStatus('registerStatus', '');
  showLoading('Membuat akun...', 'Menyiapkan spreadsheet pribadi Anda, bisa sampai 20 detik.');
  try {
    token = '';
    const data = await api('register', {
      nama: v('regNama'), nip: v('regNip'), email: v('regEmail'),
      password: $('regPassword').value, jabatan: v('regJabatan'), unitKerja: v('regUnit'),
      atasan: v('regAtasan'), nipAtasan: v('regNipAtasan'), kodeUndangan: v('regKode')
    });
    hideLoading();
    startSession(data, true);
    $('formRegister').reset();
    $('regUnit').value = 'Fakultas Tarbiyah';
    await swalBase.fire({
      icon: 'success', title: 'Akun berhasil dibuat',
      text: data.shared ? 'Spreadsheet pribadi Anda sudah dibagikan ke Google Drive. Atur API key Gemini di menu Profil untuk mengaktifkan AI.'
                        : 'Akun dibuat. Atur API key Gemini di menu Profil untuk mengaktifkan AI.',
      confirmButtonText: 'Mulai'
    });
  } catch (err) {
    hideLoading();
    setStatus('registerStatus', err.message, 'error');
  }
}

function logout() {
  clearToken();
  token = '';
  profile = null;
  categories = null;
  lastReport = null;
  showAuth();
}

function handleSessionExpired(msg) {
  clearToken();
  token = '';
  if (!$('appShell').classList.contains('hidden')) {
    showAuth();
    toast(msg || 'Sesi berakhir, silakan masuk lagi.', 'warning');
  }
}

function showAuthTab(which) {
  const login = which === 'login';
  $('tabLogin').classList.toggle('active', login);
  $('tabRegister').classList.toggle('active', !login);
  $('formLogin').classList.toggle('hidden', !login);
  $('formRegister').classList.toggle('hidden', login);
}

function showAuth() {
  $('appShell').classList.add('hidden');
  $('authScreen').classList.remove('hidden');
  showAuthTab('login');
}

function showApp() {
  $('authScreen').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  renderProfileHeader();
  renderAiState();
  switchView(currentView);
}

function renderProfileHeader() {
  const info = [profile.nip ? 'NIP. ' + profile.nip : '', profile.jabatan].filter(Boolean).join(' · ');
  qsa('.js-user-name').forEach(el => { el.textContent = profile.nama || '-'; });
  qsa('.js-user-info').forEach(el => { el.textContent = info; });
}

/** Aktif/nonaktifkan fitur AI sesuai ada tidaknya API key milik dosen. */
function renderAiState() {
  if (!profile) return;
  const on = !!profile.hasGeminiKey;
  $('aiNotice').classList.toggle('hidden', on || currentMode !== 'ai');
  $('btnSave').disabled = !on;
  $('btnMic').disabled = !on || !recognition;
  $('narasiInput').disabled = !on;
  $('autoSend').disabled = !on;

  const st = $('keyState');
  st.textContent = on ? 'Key terpasang: ' + profile.geminiKeyHint : 'Belum ada key — fitur AI nonaktif.';
  st.className = 'status' + (on ? ' ok' : '');
  $('btnRemoveKey').disabled = !on;
}

// ============================== NAVIGASI MENU ==============================
function switchView(view) {
  currentView = view;
  VIEWS.forEach(v => $('view-' + v).classList.toggle('hidden', v !== view));
  qsa('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  window.scrollTo(0, 0);

  if (view === 'input') { loadToday(); }
  if (view === 'log') loadLogs();
  if (view === 'report') loadMonthSummary();
  if (view === 'profile') fillProfileForm();
}

// ============================== DAFTAR KEGIATAN (dipakai Input & Log) ==============================
function entryCardHtml(item) {
  return '<span class="tag">' + esc(item.judulLaporan) + '</span>' +
    '<div class="text-[15px] text-slate-800">' + esc(item.deskripsi) + '</div>' +
    '<div class="muted mt-0.5">Jml: ' + esc(item.jml) + ' ' + esc(item.satuan) + '</div>';
}

function renderEntryList(container, logs, onChange) {
  if (!logs.length) {
    container.innerHTML = '<div class="empty"><span class="big">🗒️</span>Belum ada kegiatan pada tanggal ini.</div>';
    return;
  }
  container.innerHTML = '';
  logs.forEach(log => {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = entryCardHtml(log) +
      '<div class="flex flex-wrap gap-2 mt-3">' +
        '<button class="btn btn-outline btn-sm js-edit">✏️ Edit</button>' +
        '<button class="btn btn-danger btn-sm js-del">Hapus</button>' +
      '</div>';
    div.querySelector('.js-edit').addEventListener('click', () => editLog(log, onChange));
    div.querySelector('.js-del').addEventListener('click', () => deleteLog(log, onChange));
    container.appendChild(div);
  });
}

/** Pop-up form kegiatan (dipakai untuk Edit dan Tambah Manual). Return true bila tersimpan. */
async function openEntryModal(opts) {
  let cats;
  try {
    cats = await getCategories();
  } catch (err) {
    await showError('Gagal memuat kategori', err);
    return false;
  }
  const init = opts.initial || {};
  const options = cats.map(c =>
    '<option value="' + esc(c) + '"' + (c === init.judulLaporan ? ' selected' : '') + '>' + esc(c) + '</option>').join('');

  const res = await swalBase.fire({
    title: opts.title,
    html:
      '<div class="text-left space-y-3.5">' +
        '<div><label class="lbl" for="mdDesk">Deskripsi</label><textarea id="mdDesk" class="field !min-h-[90px]"></textarea></div>' +
        '<div><label class="lbl" for="mdJudul">Judul laporan</label><select id="mdJudul" class="field">' + options + '</select></div>' +
        '<div><label class="lbl" for="mdJml">Jumlah</label><input id="mdJml" type="number" min="1" class="field"></div>' +
      '</div>',
    showCancelButton: true, confirmButtonText: opts.confirmText, cancelButtonText: 'Batal', focusConfirm: false,
    didOpen: () => {
      $('mdDesk').value = init.deskripsi || '';
      $('mdJml').value = init.jml || 1;
    },
    preConfirm: async () => {
      const vals = { deskripsi: $('mdDesk').value.trim(), judulLaporan: $('mdJudul').value, jml: $('mdJml').value };
      if (!vals.deskripsi) { Swal.showValidationMessage('Deskripsi wajib diisi.'); return false; }
      try {
        await opts.onSubmit(vals);
        return true;
      } catch (err) {
        Swal.showValidationMessage('Gagal: ' + err.message);
        return false;
      }
    }
  });
  return res.isConfirmed;
}

async function editLog(log, onChange) {
  const saved = await openEntryModal({
    title: 'Edit kegiatan', initial: log, confirmText: 'Simpan',
    onSubmit: vals => api('updateLog', { id: log.id, fields: vals })
  });
  if (saved) { toast('Perubahan disimpan'); onChange(); }
}

async function deleteLog(log, onChange) {
  const ok = await confirmBox({
    title: 'Hapus kegiatan?', text: log.deskripsi, confirmText: 'Ya, hapus', danger: true
  });
  if (!ok) return;
  try {
    await api('deleteLog', { id: log.id });
    toast('Kegiatan dihapus');
    onChange();
  } catch (err) {
    showError('Gagal menghapus', err);
  }
}

// ============================== INFO TANGGAL / LIBUR ==============================
async function fetchDayInfo(tanggal) {
  if (!dayInfoCache[tanggal]) dayInfoCache[tanggal] = await api('getDayInfo', { tanggal });
  return dayInfoCache[tanggal];
}

async function loadDayInfo() {
  const banner = $('dayBanner');
  const tanggal = $('tanggalInput').value;
  banner.classList.add('hidden');
  if (!tanggal) return;
  try {
    const info = await fetchDayInfo(tanggal);
    if (tanggal !== $('tanggalInput').value) return; // tanggal sudah berganti
    if (info.libur) {
      banner.textContent = '📅 ' + info.keterangan + ' — tercatat sebagai hari libur.';
      banner.classList.remove('hidden');
    }
  } catch (err) { /* info libur hanya tambahan; abaikan bila gagal */ }
}

/** Beri konfirmasi bila tanggal jatuh pada hari libur. Return true bila boleh lanjut. */
async function confirmHolidayIfNeeded(tanggal) {
  let info;
  try { info = await fetchDayInfo(tanggal); } catch (e) { return true; }
  if (!info.libur) return true;
  return confirmBox({
    title: 'Tanggal ini hari libur',
    text: info.keterangan + '. Tetap simpan kegiatan pada tanggal ini?',
    confirmText: 'Tetap simpan'
  });
}

// ============================== MENU 1: INPUT HARIAN ==============================
function setMode(mode) {
  currentMode = mode;
  $('modeAi').classList.toggle('active', mode === 'ai');
  $('modeManual').classList.toggle('active', mode === 'manual');
  $('panelAi').classList.toggle('hidden', mode !== 'ai');
  $('panelManual').classList.toggle('hidden', mode !== 'manual');
  if (mode === 'manual') fillManualCategories();
  renderAiState();
}

async function fillManualCategories() {
  const sel = $('mJudul');
  if (sel.options.length) return;
  try {
    (await getCategories()).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
  } catch (err) {
    setStatus('manualStatus', 'Gagal memuat kategori: ' + err.message, 'error');
  }
}

function setupSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $('btnMic').disabled = true;
    $('micStatus').textContent = 'Rekam suara tidak didukung browser ini (gunakan Chrome/Edge).';
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
  recognition.onend = () => { if (isRecording) recognition.start(); };
}

function toggleMic() {
  if (!recognition) return;
  if (isRecording) {
    stopRecording();
    if ($('autoSend').checked) {
      // beri waktu hasil akhir pengenalan suara masuk ke kolom teks
      setTimeout(() => { if ($('narasiInput').value.trim()) saveActivities(); }, 900);
    }
    return;
  }
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

async function saveActivities() {
  const tanggal = $('tanggalInput').value;
  const narasi = $('narasiInput').value.trim();
  if (!tanggal) return setStatus('saveStatus', 'Pilih tanggal dulu.', 'error');
  if (!narasi) return setStatus('saveStatus', 'Ceritakan kegiatan Anda dulu.', 'error');
  if (isRecording) stopRecording();
  setStatus('saveStatus', '');

  if (!(await confirmHolidayIfNeeded(tanggal))) return;

  showLoading('Memproses dengan AI...', 'Gemini sedang memecah cerita Anda menjadi baris laporan.');
  try {
    const saved = await api('saveLog', { tanggal, narasi });
    hideLoading();
    $('narasiInput').value = '';
    transcriptBase = '';
    toast(saved.length + ' kegiatan tersimpan');
    loadToday();
  } catch (err) {
    hideLoading();
    if (err.code === 'NO_KEY') profile.hasGeminiKey = false;
    await showError('Gagal memproses', err);
  } finally {
    renderAiState();
  }
}

async function saveManual() {
  const tanggal = $('tanggalInput').value;
  const deskripsi = $('mDesk').value.trim();
  if (!tanggal) return setStatus('manualStatus', 'Pilih tanggal dulu.', 'error');
  if (!deskripsi) return setStatus('manualStatus', 'Deskripsi wajib diisi.', 'error');
  if (!$('mJudul').value) return setStatus('manualStatus', 'Pilih judul laporan.', 'error');
  setStatus('manualStatus', '');

  if (!(await confirmHolidayIfNeeded(tanggal))) return;

  const btn = $('btnSaveManual');
  setBusy(btn, true, 'Menyimpan...');
  try {
    await api('addLog', { tanggal, deskripsi, judulLaporan: $('mJudul').value, jml: $('mJml').value });
    $('mDesk').value = '';
    $('mJml').value = 1;
    toast('Kegiatan tersimpan');
    loadToday();
  } catch (err) {
    showError('Gagal menyimpan', err);
  } finally {
    setBusy(btn, false);
  }
}

/** Pratinjau kegiatan pada tanggal yang dipilih (tampil di bawah form input). */
async function loadToday() {
  const tanggal = $('tanggalInput').value;
  loadDayInfo();
  const listEl = $('todayList');
  listEl.innerHTML = '<div class="empty">Memuat...</div>';
  try {
    const logs = await api('getLogs', { tanggal });
    if (tanggal !== $('tanggalInput').value) return;
    $('todayCount').textContent = logs.length;
    renderEntryList(listEl, logs, loadToday);
  } catch (err) {
    listEl.innerHTML = '<div class="empty">Gagal memuat: ' + esc(err.message) + '</div>';
  }
}

// ============================== MENU 2: LOG KEGIATAN ==============================
async function loadLogs() {
  const tanggal = $('logDate').value;
  $('logDateLabel').textContent = labelTanggal(tanggal);
  const listEl = $('logList');
  listEl.innerHTML = '<div class="empty">Memuat...</div>';
  try {
    const logs = await api('getLogs', { tanggal });
    if (tanggal !== $('logDate').value) return;
    renderEntryList(listEl, logs, loadLogs);
  } catch (err) {
    listEl.innerHTML = '<div class="empty">Gagal memuat: ' + esc(err.message) + '</div>';
  }
}

async function addManualFromLog() {
  const tanggal = $('logDate').value;
  if (!(await confirmHolidayIfNeeded(tanggal))) return;
  const saved = await openEntryModal({
    title: 'Tambah kegiatan — ' + labelTanggal(tanggal), initial: {}, confirmText: 'Tambah',
    onSubmit: vals => api('addLog', { tanggal, ...vals })
  });
  if (saved) { toast('Kegiatan ditambahkan'); loadLogs(); }
}

// ============================== MENU 3: CETAK LAPORAN ==============================
async function loadMonthSummary() {
  const month = $('monthInput').value;
  $('statDays').textContent = '-';
  $('statTotal').textContent = '-';
  resetReportOutput();
  if (!month) return;
  try {
    const s = await api('getMonthSummary', { month });
    $('statDays').textContent = s.hariTerisi;
    $('statTotal').textContent = s.totalKegiatan;
  } catch (err) {
    setStatus('reportStatus', 'Gagal memuat ringkasan: ' + err.message, 'error');
  }
}

function resetReportOutput() {
  lastReport = null;
  $('btnPrint').disabled = true;
  $('previewPaper').classList.add('hidden');
  $('previewPaper').innerHTML = '';
  $('reportResult').classList.add('hidden');
  setStatus('reportStatus', '');
}

/** <img> tanda tangan (hanya data URL PNG/JPG yang dibuat server). */
function ttdImg(dataUrl) {
  if (!dataUrl || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/=]+$/.test(dataUrl)) return '';
  return '<img src="' + dataUrl + '" alt="Tanda tangan" style="height:58px;max-width:170px;object-fit:contain;">';
}

/** Susun HTML laporan dari data server (semua teks di-escape). */
function buildReportHtml(d) {
  const p = d.profile;
  let body = '';
  d.rows.forEach(row => {
    if (row.jenis === 'libur') {
      body += '<tr><td style="text-align:right;vertical-align:middle;background:#fadbd8;font-style:italic;">' + esc(row.label) +
        '</td><td colspan="5" class="libur" style="background:#fadbd8;font-style:italic;">' + esc(row.keterangan) + '</td></tr>';
    } else if (row.jenis === 'kosong') {
      body += '<tr><td style="text-align:right;vertical-align:middle;">' + esc(row.label) + '</td><td></td><td></td><td></td><td></td><td></td></tr>';
    } else {
      row.entries.forEach((e, i) => {
        body += '<tr>' +
          (i === 0 ? '<td rowspan="' + row.entries.length + '" style="text-align:right;vertical-align:middle;">' + esc(row.label) + '</td>' : '') +
          '<td class="c">' + (i + 1) + '</td><td>' + esc(e.deskripsi) + '</td>' +
          '<td class="c">' + esc(e.judulLaporan) + '</td><td class="c">' + esc(e.jml) + '</td>' +
          '<td class="c">' + esc(e.satuan) + '</td></tr>';
      });
    }
  });

  const ident = [['Nama', p.nama], ['NIP', p.nip], ['Jabatan', p.jabatan || '-'],
                 ['Unit Kerja', p.unitKerja || '-'], ['Satuan Kerja', p.satuanKerja]]
    .map(r => '<tr><td style="width:90px;">' + r[0] + '</td><td style="width:10px;">:</td><td>' + esc(r[1]) + '</td></tr>').join('');

  return '<div class="report">' +
    '<div style="display:flex;align-items:center;gap:10px;">' +
    '<img src="logo-uin.png" alt="Logo UIN" style="width:64px;height:auto;flex:none;" onerror="this.style.visibility=\'hidden\'">' +
    '<div class="kop" style="flex:1;"><div class="t1">KEMENTERIAN AGAMA REPUBLIK INDONESIA</div>' +
    '<div class="t1">UNIVERSITAS ISLAM NEGERI SYEKH WASIL KEDIRI</div>' +
    '<div style="font-weight:normal;">Jalan Sunan Ampel Nomor 07 Ngronggo Kota Kediri Kode Pos 64127<br>' +
    'Telepon (0354) 689282 Faksimile (0354) 686564 Website: www.uinkediri.ac.id</div></div>' +
    '<div style="width:64px;flex:none;"></div></div>' +   // penyeimbang agar teks kop tetap di tengah halaman
    '<hr style="border:0;border-top:2px solid #000;margin:8px 0 0;">' +
    '<div class="judul">LAPORAN KINERJA BULANAN</div>' +
    '<div class="periode">Periode: Bulan ' + esc(d.periode.replace(' ', ' Tahun ')) + '</div>' +
    '<table class="ident">' + ident + '</table>' +
    '<table class="data"><thead><tr><th style="width:17%;">Tanggal</th><th style="width:4%;">No</th>' +
    '<th>Deskripsi Laporan Kerja</th><th style="width:15%;">Judul Laporan</th><th style="width:5%;">Jml</th>' +
    '<th style="width:9%;">Satuan</th></tr></thead><tbody>' + body + '</tbody></table>' +
    '<p style="margin:14px 0 0;">Demikian laporan kinerja bulanan ini dibuat berdasarkan dengan yang sebenarnya.</p>' +
    '<table class="ttd"><tr><td>Mengetahui,<br>Atasan Langsung,</td><td>' + esc(d.tanggalCetak) + '<br>Yang membuat laporan,</td></tr>' +
    '<tr><td class="space">' + ttdImg(d.ttd && d.ttd.atasan) + '</td><td class="space">' + ttdImg(d.ttd && d.ttd.user) + '</td></tr>' +
    '<tr><td><b><u>' + esc(p.atasan || '') + '</u></b><br>NIP. ' + esc(p.nipAtasan || '') + '</td>' +
    '<td><b><u>' + esc(p.nama) + '</u></b><br>NIP. ' + esc(p.nip) + '</td></tr></table>' +
    '</div>';
}

async function previewReport() {
  const month = $('monthInput').value;
  if (!month) return setStatus('reportStatus', 'Pilih bulan dulu.', 'error');

  resetReportOutput();
  showLoading('Menyusun pratinjau...');
  try {
    const d = await api('getReportData', { month, ttd: $('useTtd').checked });
    const html = buildReportHtml(d);
    lastReport = {
      html,
      title: 'LKB_' + d.periode.replace(' ', '_') + '_' + d.profile.nama.replace(/[^\w ]/g, '').replace(/ /g, '_')
    };
    $('previewPaper').innerHTML = html;
    $('previewPaper').classList.remove('hidden');
    $('btnPrint').disabled = false;
    hideLoading();
    $('previewPaper').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    hideLoading();
    showError('Gagal membuat pratinjau', err);
  }
}

function printReport() {
  if (!lastReport) return;
  $('printArea').innerHTML = lastReport.html;
  const oldTitle = document.title;
  document.title = lastReport.title; // jadi nama file saat "Simpan sebagai PDF"
  window.onafterprint = () => { document.title = oldTitle; window.onafterprint = null; };
  window.print();
}

function base64ToBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}

async function downloadPdf() {
  const month = $('monthInput').value;
  if (!month) return setStatus('reportStatus', 'Pilih bulan dulu.', 'error');

  $('reportResult').classList.add('hidden');
  showLoading('Membuat PDF resmi...', 'Menyusun sheet laporan lalu mengekspornya, bisa sampai 30 detik.');
  try {
    const res = await api('generateReport', { month, ttd: $('useTtd').checked });
    const url = base64ToBlobUrl(res.base64);
    hideLoading();

    const box = $('reportResult');
    box.innerHTML = '✅ PDF siap. <a class="underline font-semibold" href="' + url + '" download="' + esc(res.filename) +
      '">Unduh ' + esc(res.filename) + '</a><br><span class="muted">Salinan sheet "' + esc(res.sheetName) +
      '" juga tersimpan di spreadsheet pribadi Anda.</span>';
    box.classList.remove('hidden');

    await swalBase.fire({
      icon: 'success', title: 'PDF siap',
      html: '<a class="btn btn-primary" href="' + url + '" download="' + esc(res.filename) + '">⬇️ Unduh PDF</a>',
      showConfirmButton: false, showCloseButton: true
    });
  } catch (err) {
    hideLoading();
    showError('Gagal membuat PDF', err);
  }
}

// ============================== MENU 4: PROFIL ==============================
// ----- tanda tangan digital (opsional) -----
/** Perkecil gambar (maks 480x200), hapus latar putih -> PNG transparan (data URL). */
function fileToSignatureDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) return reject(new Error('Gunakan gambar PNG atau JPG.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Gagal membaca file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Gambar tidak bisa dibuka.'));
      img.onload = () => {
        const k = Math.min(1, 480 / img.width, 200 / img.height);
        const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 235 && px[i + 1] > 235 && px[i + 2] > 235) px[i + 3] = 0;   // latar putih -> transparan
        }
        ctx.putImageData(data, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const TTD_IDS = { user: { img: 'ttdUserImg', empty: 'ttdUserEmpty', file: 'ttdUserFile', del: 'btnDelTtdUser' },
                  atasan: { img: 'ttdAtasanImg', empty: 'ttdAtasanEmpty', file: 'ttdAtasanFile', del: 'btnDelTtdAtasan' } };

function renderTtd(who, dataUrl) {
  const ids = TTD_IDS[who];
  const ok = !!dataUrl && /^data:image\/(png|jpeg);base64,/.test(dataUrl);
  const img = $(ids.img);
  if (ok) img.src = dataUrl; else img.removeAttribute('src');
  img.classList.toggle('hidden', !ok);
  $(ids.empty).classList.toggle('hidden', ok);
  $(ids.del).classList.toggle('hidden', !ok);
}

async function loadSignatures() {
  try {
    const s = await api('getSignatures');
    renderTtd('user', s.user);
    renderTtd('atasan', s.atasan);
  } catch (err) {
    setStatus('ttdStatus', 'Gagal memuat tanda tangan: ' + err.message, 'error');
  }
}

async function uploadSignature(who, inputEl) {
  const file = inputEl.files && inputEl.files[0];
  inputEl.value = '';
  if (!file) return;
  setStatus('ttdStatus', '');
  showLoading('Mengunggah tanda tangan...');
  try {
    const dataUrl = await fileToSignatureDataUrl(file);
    profile = await api('saveSignature', { who, dataUrl });
    renderTtd(who, dataUrl);
    hideLoading();
    toast('Tanda tangan tersimpan');
  } catch (err) {
    hideLoading();
    setStatus('ttdStatus', 'Gagal: ' + err.message, 'error');
  }
}

async function deleteSignature(who) {
  const ok = await confirmBox({ title: 'Hapus tanda tangan?', text: 'Laporan berikutnya akan dicetak tanpa gambar tanda tangan ini.',
                                confirmText: 'Ya, hapus', danger: true });
  if (!ok) return;
  try {
    profile = await api('removeSignature', { who });
    renderTtd(who, '');
    toast('Tanda tangan dihapus');
  } catch (err) {
    showError('Gagal menghapus tanda tangan', err);
  }
}

function fillProfileForm() {
  $('pfNama').value = profile.nama || '';
  $('pfNip').value = profile.nip || '';
  $('pfEmail').value = profile.email || '';
  $('pfJabatan').value = profile.jabatan || '';
  $('pfUnit').value = profile.unitKerja || '';
  $('pfAtasan').value = profile.atasan || '';
  $('pfNipAtasan').value = profile.nipAtasan || '';
  setStatus('profileStatus', '');
  setStatus('keyStatus', '');
  renderAiState();
  setStatus('ttdStatus', '');
  loadSignatures();
  $('fileLinkBox').innerHTML = profile.fileUrl
    ? 'Spreadsheet pribadi Anda: <a class="text-emerald-700 underline" href="' + esc(profile.fileUrl) + '" target="_blank" rel="noopener">buka di Google Sheets</a>'
    : '';
}

async function saveProfile() {
  const btn = $('btnSaveProfile');
  setBusy(btn, true, 'Menyimpan...');
  try {
    profile = await api('updateProfile', {
      nama: $('pfNama').value, nip: $('pfNip').value, jabatan: $('pfJabatan').value,
      unitKerja: $('pfUnit').value, atasan: $('pfAtasan').value, nipAtasan: $('pfNipAtasan').value
    });
    renderProfileHeader();
    renderAiState();
    toast('Profil tersimpan');
  } catch (err) {
    setStatus('profileStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function changePassword() {
  if ($('pwNew').value !== $('pwNew2').value) return setStatus('pwStatus', 'Konfirmasi password baru tidak sama.', 'error');
  const btn = $('btnChangePw');
  setBusy(btn, true, 'Memproses...');
  setStatus('pwStatus', '');
  try {
    await api('changePassword', { oldPassword: $('pwOld').value, newPassword: $('pwNew').value });
    ['pwOld', 'pwNew', 'pwNew2'].forEach(id => { $(id).value = ''; });
    toast('Password berhasil diganti');
  } catch (err) {
    setStatus('pwStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function saveGeminiKey() {
  const key = $('gemKey').value.trim();
  if (!key) return setStatus('keyStatus', 'Tempel API key Anda dulu.', 'error');
  setStatus('keyStatus', '');
  showLoading('Memeriksa API key...', 'Key diperiksa ke Google sebelum disimpan.');
  try {
    profile = await api('setGeminiKey', { apiKey: key });
    hideLoading();
    $('gemKey').value = '';
    toast('Key valid dan tersimpan. Fitur AI aktif.');
  } catch (err) {
    hideLoading();
    setStatus('keyStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    renderAiState();
  }
}

async function removeGeminiKey() {
  const ok = await confirmBox({
    title: 'Hapus API key?', text: 'Fitur AI akan nonaktif sampai Anda mengisi key lagi.',
    confirmText: 'Ya, hapus', danger: true
  });
  if (!ok) return;
  try {
    profile = await api('removeGeminiKey');
    toast('Key dihapus');
  } catch (err) {
    showError('Gagal menghapus key', err);
  } finally {
    renderAiState();
  }
}

// ============================== INIT ==============================
document.addEventListener('DOMContentLoaded', () => {
  $('tanggalInput').value = todayStr();
  $('logDate').value = todayStr();
  $('monthInput').value = todayStr().slice(0, 7);
  $('autoSend').checked = localStorage.getItem(AUTOSEND_KEY) === '1';

  // masuk / daftar
  $('tabLogin').addEventListener('click', () => showAuthTab('login'));
  $('tabRegister').addEventListener('click', () => showAuthTab('register'));
  $('formLogin').addEventListener('submit', onLogin);
  $('formRegister').addEventListener('submit', onRegister);
  qsa('[data-toggle]').forEach(btn => btn.addEventListener('click', () => {
    const input = $(btn.dataset.toggle);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Sembunyi' : 'Lihat';
  }));
  qsa('.js-logout').forEach(b => b.addEventListener('click', logout));

  // navigasi
  qsa('[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

  // input
  $('modeAi').addEventListener('click', () => setMode('ai'));
  $('modeManual').addEventListener('click', () => setMode('manual'));
  $('btnMic').addEventListener('click', toggleMic);
  $('btnSave').addEventListener('click', saveActivities);
  $('btnSaveManual').addEventListener('click', saveManual);
  $('narasiInput').addEventListener('input', e => { transcriptBase = e.target.value; });
  $('autoSend').addEventListener('change', e => localStorage.setItem(AUTOSEND_KEY, e.target.checked ? '1' : '0'));
  $('tanggalInput').addEventListener('change', loadToday);
  $('btnRefreshToday').addEventListener('click', loadToday);
  $('btnGoProfileKey').addEventListener('click', () => {
    switchView('profile');
    $('geminiCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('gemKey').focus();
  });
  $('btnUseManual').addEventListener('click', () => setMode('manual'));

  // log
  $('logDate').addEventListener('change', loadLogs);
  $('btnPrevDay').addEventListener('click', () => { $('logDate').value = shiftDate($('logDate').value, -1); loadLogs(); });
  $('btnNextDay').addEventListener('click', () => { $('logDate').value = shiftDate($('logDate').value, 1); loadLogs(); });
  $('btnAddManual').addEventListener('click', addManualFromLog);
  $('btnAddStory').addEventListener('click', () => {
    $('tanggalInput').value = $('logDate').value;
    setMode('ai');
    switchView('input');
    $('narasiInput').focus();
  });

  // cetak
  $('monthInput').addEventListener('change', loadMonthSummary);
  $('btnPreview').addEventListener('click', previewReport);
  $('btnPrint').addEventListener('click', printReport);
  $('btnPdf').addEventListener('click', downloadPdf);

  // profil
  $('btnSaveProfile').addEventListener('click', saveProfile);
  $('btnChangePw').addEventListener('click', changePassword);
  $('btnSaveKey').addEventListener('click', saveGeminiKey);
  $('btnRemoveKey').addEventListener('click', removeGeminiKey);
  $('ttdUserFile').addEventListener('change', e => uploadSignature('user', e.target));
  $('ttdAtasanFile').addEventListener('change', e => uploadSignature('atasan', e.target));
  $('btnDelTtdUser').addEventListener('click', () => deleteSignature('user'));
  $('btnDelTtdAtasan').addEventListener('click', () => deleteSignature('atasan'));

  setupSpeech();

  // lanjutkan sesi kalau token tersimpan
  const saved = getSavedToken();
  if (saved) {
    token = saved;
    api('getProfile')
      .then(p => { profile = p; showApp(); })
      .catch(() => { token = ''; showAuth(); });
  } else {
    showAuth();
  }
});
