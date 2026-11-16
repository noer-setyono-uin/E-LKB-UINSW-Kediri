// =====================================================================
//  E-LKB — logika client
//  Ganti API_URL di bawah dengan URL Web App Apps Script Anda (berakhiran /exec).
// =====================================================================
const API_URL = 'GANTI_DENGAN_URL_WEB_APP_ANDA/exec';

const TOKEN_KEY = 'lkb_token';
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const VIEWS = ['input', 'log', 'report', 'profile'];

// ============================== STATE ==============================
let token = '';
let profile = null;
let currentView = 'input';
let categories = null;        // daftar Judul Laporan (diambil sekali)
let recognition = null;
let isRecording = false;
let transcriptBase = '';
let lastReport = null;        // { html, title } hasil pratinjau terakhir

// ============================== HELPER ==============================
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
  el.className = 'status' + (type ? ' ' + type : '');
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
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

// ============================== API ==============================
/**
 * Semua panggilan ke Apps Script lewat POST text/plain (tanpa preflight CORS):
 *   { token, action, payload }  ->  { ok, data } | { ok:false, error, code }
 * Token sesi dibuat server saat masuk; ID file dosen TIDAK pernah dikirim dari sini.
 */
async function api(action, payload = {}) {
  if (API_URL.indexOf('script.google.com') === -1) {
    throw new Error('API_URL di app.js belum diisi dengan URL Web App Anda.');
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token, action, payload })
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
  const btn = $('btnRegister');
  setBusy(btn, true, 'Mendaftarkan...');
  setStatus('registerStatus', 'Membuat akun & spreadsheet pribadi Anda, mohon tunggu...');
  try {
    token = '';
    const data = await api('register', {
      nama: v('regNama'), nip: v('regNip'), email: v('regEmail'),
      password: $('regPassword').value, jabatan: v('regJabatan'), unitKerja: v('regUnit'),
      atasan: v('regAtasan'), nipAtasan: v('regNipAtasan'), kodeUndangan: v('regKode')
    });
    startSession(data, true);
    $('formRegister').reset();
    $('regUnit').value = 'Fakultas Tarbiyah';
    setStatus('registerStatus', '');
    toast(data.shared ? 'Akun dibuat. Spreadsheet Anda sudah dibagikan ke Google Drive.' : 'Akun dibuat.');
  } catch (err) {
    setStatus('registerStatus', err.message, 'error');
  } finally {
    setBusy(btn, false);
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
    setStatus('loginStatus', msg || 'Sesi berakhir, silakan masuk lagi.', 'error');
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

/** Aktif/nonaktifkan fitur AI sesuai ada tidaknya API key milik dosen. */
function renderAiState() {
  if (!profile) return;
  const on = !!profile.hasGeminiKey;
  $('aiNotice').classList.toggle('hidden', on);
  $('btnSave').disabled = !on;
  $('btnMic').disabled = !on || !recognition;
  $('narasiInput').disabled = !on;
  const st = $('keyState');
  st.textContent = on ? 'Key terpasang: ' + profile.geminiKeyHint : 'Belum ada key — fitur AI nonaktif.';
  st.className = 'status' + (on ? ' ok' : '');
  $('btnRemoveKey').disabled = !on;
}

function renderProfileHeader() {
  const info = [profile.nip ? 'NIP. ' + profile.nip : '', profile.jabatan].filter(Boolean).join(' · ');
  qsa('.js-user-name').forEach(el => { el.textContent = profile.nama || '-'; });
  qsa('.js-user-info').forEach(el => { el.textContent = info; });
}

// ============================== NAVIGASI MENU ==============================
function switchView(view) {
  currentView = view;
  VIEWS.forEach(v => $('view-' + v).classList.toggle('hidden', v !== view));
  qsa('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  window.scrollTo(0, 0);

  if (view === 'log') loadLogs();
  if (view === 'report') loadMonthSummary();
  if (view === 'profile') fillProfileForm();
}

// ============================== MENU 1: INPUT HARIAN ==============================
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

async function saveActivities() {
  const tanggal = $('tanggalInput').value;
  const narasi = $('narasiInput').value.trim();
  if (!tanggal) return setStatus('saveStatus', 'Pilih tanggal dulu.', 'error');
  if (!narasi) return setStatus('saveStatus', 'Ceritakan kegiatan Anda dulu.', 'error');
  if (isRecording) stopRecording();

  const btn = $('btnSave');
  setBusy(btn, true, 'Memproses dengan AI...');
  setStatus('saveStatus', '');
  try {
    const saved = await api('saveLog', { tanggal, narasi });
    $('narasiInput').value = '';
    transcriptBase = '';
    renderSaved(saved);
    toast(saved.length + ' kegiatan tersimpan');
  } catch (err) {
    if (err.code === 'NO_KEY') profile.hasGeminiKey = false;
    setStatus('saveStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
    renderAiState();
  }
}

function entryCardHtml(item) {
  return '<span class="tag">' + esc(item.judulLaporan) + '</span>' +
    '<div class="entry-desc">' + esc(item.deskripsi) + '</div>' +
    '<div class="muted">Jml: ' + esc(item.jml) + ' ' + esc(item.satuan) + '</div>';
}

function renderSaved(saved) {
  const list = $('savedList');
  list.innerHTML = '';
  saved.forEach(item => {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = entryCardHtml(item);
    list.appendChild(div);
  });
  $('savedCard').classList.remove('hidden');
}

// ============================== MENU 2: LOG KEGIATAN ==============================
async function loadLogs() {
  const tanggal = $('logDate').value;
  $('logDateLabel').textContent = labelTanggal(tanggal);
  $('manualBox').innerHTML = '';
  const listEl = $('logList');
  listEl.innerHTML = '<div class="empty">Memuat...</div>';
  try {
    renderLogs(await api('getLogs', { tanggal }));
  } catch (err) {
    listEl.innerHTML = '<div class="empty">Gagal memuat: ' + esc(err.message) + '</div>';
  }
}

function renderLogs(logs) {
  const listEl = $('logList');
  if (!logs.length) {
    listEl.innerHTML = '<div class="empty"><span class="big">🗒️</span>Belum ada kegiatan pada tanggal ini.</div>';
    return;
  }
  listEl.innerHTML = '';
  logs.forEach(log => {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = entryCardHtml(log) +
      '<div class="entry-actions">' +
        '<button class="btn btn-outline btn-sm js-edit">✏️ Edit</button>' +
        '<button class="btn btn-danger btn-sm js-del">Hapus</button>' +
      '</div>';
    div.querySelector('.js-edit').addEventListener('click', () => editLog(div, log));
    div.querySelector('.js-del').addEventListener('click', () => deleteLog(log.id));
    listEl.appendChild(div);
  });
}

/** Form entri (dipakai untuk Edit dan Tambah Manual). */
async function renderEntryForm(container, initial, opts) {
  try {
    if (!categories) categories = await api('getCategories');
  } catch (err) {
    return toast('Gagal memuat kategori: ' + err.message);
  }
  container.innerHTML =
    '<label>Deskripsi</label><textarea class="e-desk" style="min-height:80px;"></textarea>' +
    '<label>Judul Laporan</label><select class="e-judul"></select>' +
    '<label>Jml</label><input type="number" min="1" class="e-jml">' +
    '<div class="edit-actions">' +
      '<button class="btn btn-primary btn-sm e-save"></button>' +
      '<button class="btn btn-outline btn-sm e-cancel">Batal</button>' +
    '</div><div class="status e-status"></div>';

  const desk = container.querySelector('.e-desk');
  const judul = container.querySelector('.e-judul');
  const jml = container.querySelector('.e-jml');
  const saveBtn = container.querySelector('.e-save');
  saveBtn.textContent = opts.submitLabel;
  desk.value = initial.deskripsi || '';
  jml.value = initial.jml || 1;
  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === initial.judulLaporan) opt.selected = true;
    judul.appendChild(opt);
  });

  container.querySelector('.e-cancel').addEventListener('click', opts.onCancel);
  saveBtn.addEventListener('click', async () => {
    if (!desk.value.trim()) {
      const st = container.querySelector('.e-status');
      st.textContent = 'Deskripsi wajib diisi.';
      st.className = 'status error e-status';
      return;
    }
    saveBtn.disabled = true;
    try {
      await opts.onSubmit({ deskripsi: desk.value, judulLaporan: judul.value, jml: jml.value });
    } catch (err) {
      saveBtn.disabled = false;
      const st = container.querySelector('.e-status');
      st.textContent = 'Gagal: ' + err.message;
      st.className = 'status error e-status';
    }
  });
}

function editLog(div, log) {
  renderEntryForm(div, log, {
    submitLabel: 'Simpan',
    onCancel: loadLogs,
    onSubmit: async fields => {
      await api('updateLog', { id: log.id, fields });
      toast('Perubahan disimpan');
      loadLogs();
    }
  });
}

function addManual() {
  const box = $('manualBox');
  box.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'entry';
  box.appendChild(div);
  renderEntryForm(div, {}, {
    submitLabel: 'Tambah',
    onCancel: () => { box.innerHTML = ''; },
    onSubmit: async fields => {
      await api('addLog', { tanggal: $('logDate').value, ...fields });
      toast('Kegiatan ditambahkan');
      loadLogs();
    }
  });
}

async function deleteLog(id) {
  if (!confirm('Hapus kegiatan ini?')) return;
  try {
    await api('deleteLog', { id });
    toast('Kegiatan dihapus');
    loadLogs();
  } catch (err) {
    toast('Gagal hapus: ' + err.message);
  }
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

/** Susun HTML laporan dari data server (semua teks di-escape). */
function buildReportHtml(d) {
  const p = d.profile;
  let body = '';
  d.rows.forEach(row => {
    if (row.jenis === 'libur') {
      body += '<tr><td>' + esc(row.label) + '</td><td colspan="5" class="libur">' + esc(row.keterangan) + '</td></tr>';
    } else if (row.jenis === 'kosong') {
      body += '<tr><td>' + esc(row.label) + '</td><td></td><td></td><td></td><td></td><td></td></tr>';
    } else {
      row.entries.forEach((e, i) => {
        body += '<tr>' +
          (i === 0 ? '<td rowspan="' + row.entries.length + '">' + esc(row.label) + '</td>' : '') +
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
    '<div class="kop"><div class="t1">KEMENTERIAN AGAMA REPUBLIK INDONESIA</div>' +
    '<div class="t1">UNIVERSITAS ISLAM NEGERI SYEKH WASIL KEDIRI</div>' +
    '<div style="font-weight:normal;">Jalan Sunan Ampel Nomor 07 Ngronggo Kota Kediri Kode Pos 64127<br>' +
    'Telepon (0354) 689282 Faksimile (0354) 686564 Website: www.uinkediri.ac.id</div></div>' +
    '<hr style="border:0;border-top:2px solid #000;margin:8px 0 0;">' +
    '<div class="judul">LAPORAN KINERJA BULANAN</div>' +
    '<div class="periode">Periode: Bulan ' + esc(d.periode.replace(' ', ' Tahun ')) + '</div>' +
    '<table class="ident">' + ident + '</table>' +
    '<table class="data"><thead><tr><th style="width:17%;">Tanggal</th><th style="width:4%;">No</th>' +
    '<th>Deskripsi Laporan Kerja</th><th style="width:15%;">Judul Laporan</th><th style="width:5%;">Jml</th>' +
    '<th style="width:9%;">Satuan</th></tr></thead><tbody>' + body + '</tbody></table>' +
    '<p style="margin:14px 0 0;">Demikian laporan kinerja bulanan ini dibuat berdasarkan dengan yang sebenarnya.</p>' +
    '<table class="ttd"><tr><td>Mengetahui,<br>Atasan Langsung,</td><td>' + esc(d.tanggalCetak) + '<br>Yang membuat laporan,</td></tr>' +
    '<tr><td class="space"></td><td class="space"></td></tr>' +
    '<tr><td><b><u>' + esc(p.atasan || '') + '</u></b><br>NIP. ' + esc(p.nipAtasan || '') + '</td>' +
    '<td><b><u>' + esc(p.nama) + '</u></b><br>NIP. ' + esc(p.nip) + '</td></tr></table>' +
    '</div>';
}

async function previewReport() {
  const month = $('monthInput').value;
  if (!month) return setStatus('reportStatus', 'Pilih bulan dulu.', 'error');

  const btn = $('btnPreview');
  setBusy(btn, true, 'Memuat pratinjau...');
  resetReportOutput();
  try {
    const d = await api('getReportData', { month });
    const html = buildReportHtml(d);
    lastReport = { html, title: 'LKB_' + d.periode.replace(' ', '_') + '_' + d.profile.nama.replace(/[^\w ]/g, '').replace(/ /g, '_') };
    $('previewPaper').innerHTML = html;
    $('previewPaper').classList.remove('hidden');
    $('btnPrint').disabled = false;
    $('previewPaper').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus('reportStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
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

  const btn = $('btnPdf');
  setBusy(btn, true, 'Membuat PDF...');
  $('reportResult').classList.add('hidden');
  setStatus('reportStatus', 'Menyusun sheet laporan & PDF, mohon tunggu (bisa sampai 30 detik)...');
  try {
    const res = await api('generateReport', { month });
    const url = base64ToBlobUrl(res.base64);
    setStatus('reportStatus', '');
    const box = $('reportResult');
    box.innerHTML = '✅ PDF siap. <a href="' + url + '" download="' + esc(res.filename) +
      '"><b>Unduh ' + esc(res.filename) + '</b></a><br><span class="muted">Salinan sheet "' +
      esc(res.sheetName) + '" juga tersimpan di spreadsheet pribadi Anda.</span>';
    box.classList.remove('hidden');
  } catch (err) {
    setStatus('reportStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

// ============================== MENU 4: PROFIL ==============================
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
  $('fileLinkBox').innerHTML = profile.fileUrl
    ? 'Spreadsheet pribadi Anda: <a href="' + esc(profile.fileUrl) + '" target="_blank" rel="noopener">buka di Google Sheets</a>'
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
    setStatus('profileStatus', 'Profil tersimpan.', 'ok');
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
  try {
    await api('changePassword', { oldPassword: $('pwOld').value, newPassword: $('pwNew').value });
    ['pwOld', 'pwNew', 'pwNew2'].forEach(id => { $(id).value = ''; });
    setStatus('pwStatus', 'Password berhasil diganti.', 'ok');
  } catch (err) {
    setStatus('pwStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function saveGeminiKey() {
  const key = $('gemKey').value.trim();
  if (!key) return setStatus('keyStatus', 'Tempel API key Anda dulu.', 'error');
  const btn = $('btnSaveKey');
  setBusy(btn, true, 'Memeriksa key...');
  setStatus('keyStatus', '');
  try {
    profile = await api('setGeminiKey', { apiKey: key });
    $('gemKey').value = '';
    renderAiState();
    setStatus('keyStatus', 'Key valid dan tersimpan. Fitur AI aktif.', 'ok');
  } catch (err) {
    setStatus('keyStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
    renderAiState();
  }
}

async function removeGeminiKey() {
  if (!confirm('Hapus API key Gemini? Fitur AI akan nonaktif sampai Anda mengisi key lagi.')) return;
  const btn = $('btnRemoveKey');
  setBusy(btn, true, 'Menghapus...');
  try {
    profile = await api('removeGeminiKey');
    setStatus('keyStatus', 'Key dihapus.', 'ok');
  } catch (err) {
    setStatus('keyStatus', 'Gagal: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
    renderAiState();
  }
}

// ============================== INIT ==============================
document.addEventListener('DOMContentLoaded', () => {
  $('tanggalInput').value = todayStr();
  $('logDate').value = todayStr();
  $('monthInput').value = todayStr().slice(0, 7);

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
  $('btnMic').addEventListener('click', toggleMic);
  $('btnSave').addEventListener('click', saveActivities);
  $('narasiInput').addEventListener('input', e => { transcriptBase = e.target.value; });
  $('btnGoLog').addEventListener('click', () => { $('logDate').value = $('tanggalInput').value; switchView('log'); });

  // log
  $('logDate').addEventListener('change', loadLogs);
  $('btnPrevDay').addEventListener('click', () => { $('logDate').value = shiftDate($('logDate').value, -1); loadLogs(); });
  $('btnNextDay').addEventListener('click', () => { $('logDate').value = shiftDate($('logDate').value, 1); loadLogs(); });
  $('btnAddManual').addEventListener('click', addManual);
  $('btnAddStory').addEventListener('click', () => {
    $('tanggalInput').value = $('logDate').value;
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

  // pintasan dari peringatan "AI belum aktif"
  $('btnGoProfileKey').addEventListener('click', () => {
    switchView('profile');
    $('geminiCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('gemKey').focus();
  });
  $('btnGoManual').addEventListener('click', () => {
    $('logDate').value = $('tanggalInput').value;
    switchView('log');
    addManual();
  });

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

// // ============================== STATE ==============================
// let recognition = null;
// let isRecording = false;
// let transcriptBase = ''; // teks final (hasil ketik/rekam)

// // ============================== HELPER ==============================
// function $(id) { return document.getElementById(id); }

// function todayStr() {
//   const d = new Date();
//   return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// }

// function escapeHtml(str) {
//   const div = document.createElement('div');
//   div.textContent = str == null ? '' : String(str);
//   return div.innerHTML;
// }

// function setStatus(id, text, isError) {
//   const el = $(id);
//   el.textContent = text;
//   el.className = 'status' + (isError ? ' error' : '');
// }

// // ============================== API (Apps Script) ==============================
// function getSettings() {
//   return {
//     url: localStorage.getItem('lkb_api_url') || '',
//     token: localStorage.getItem('lkb_api_token') || ''
//   };
// }

// /**
//  * Semua panggilan ke backend lewat POST text/plain (tanpa preflight CORS).
//  * Backend membalas { ok: true, data } atau { ok: false, error }.
//  */
// async function api(action, payload = {}) {
//   const { url, token } = getSettings();
//   if (!url || !token) throw new Error('Isi URL & token di Pengaturan dulu.');

//   const res = await fetch(url, {
//     method: 'POST',
//     headers: { 'Content-Type': 'text/plain;charset=utf-8' },
//     body: JSON.stringify({ token, action, ...payload })
//   });
//   const json = await res.json();
//   if (!json.ok) throw new Error(json.error || 'Terjadi kesalahan di server.');
//   return json.data;
// }

// // ============================== INIT ==============================
// document.addEventListener('DOMContentLoaded', () => {
//   $('tanggalInput').value = todayStr();
//   $('monthInput').value = todayStr().slice(0, 7);

//   $('btnSettings').addEventListener('click', () => $('settingsCard').classList.toggle('hidden'));
//   $('btnSaveSettings').addEventListener('click', saveSettings);
//   $('btnMic').addEventListener('click', toggleMic);
//   $('btnSave').addEventListener('click', saveActivities);
//   $('btnRefreshLogs').addEventListener('click', loadLogs);
//   $('tanggalInput').addEventListener('change', loadLogs);
//   $('btnGenerate').addEventListener('click', generateReport);
//   $('narasiInput').addEventListener('input', e => { transcriptBase = e.target.value; });

//   setupSpeech();

//   const s = getSettings();
//   $('apiUrl').value = s.url;
//   $('apiToken').value = s.token;
//   if (s.url && s.token) {
//     loadProfile();
//     loadLogs();
//   } else {
//     $('settingsCard').classList.remove('hidden');
//     $('profileInfo').textContent = 'Belum terhubung — isi Pengaturan.';
//   }
// });

// // ============================== PENGATURAN ==============================
// function saveSettings() {
//   const url = $('apiUrl').value.trim();
//   const token = $('apiToken').value.trim();
//   if (!url || !token) return setStatus('settingsStatus', 'URL dan token wajib diisi.', true);

//   localStorage.setItem('lkb_api_url', url);
//   localStorage.setItem('lkb_api_token', token);
//   setStatus('settingsStatus', 'Tersimpan di browser ini.');
//   loadProfile();
//   loadLogs();
// }

// // ============================== PROFIL ==============================
// async function loadProfile() {
//   try {
//     const p = await api('getProfile');
//     $('profileInfo').textContent = p.nama + ' · NIP. ' + p.nip + (p.jabatan ? ' · ' + p.jabatan : '');
//   } catch (err) {
//     setStatus('profileInfo', 'Gagal memuat profil: ' + err.message, true);
//   }
// }

// // ============================== REKAM SUARA (Web Speech API) ==============================
// function setupSpeech() {
//   const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
//   if (!SR) {
//     $('btnMic').disabled = true;
//     $('micStatus').textContent = 'Browser tidak mendukung rekam suara. Gunakan Chrome/Edge.';
//     return;
//   }
//   recognition = new SR();
//   recognition.lang = 'id-ID';
//   recognition.continuous = true;
//   recognition.interimResults = true;

//   recognition.onresult = event => {
//     let interim = '';
//     for (let i = event.resultIndex; i < event.results.length; i++) {
//       const text = event.results[i][0].transcript;
//       if (event.results[i].isFinal) {
//         transcriptBase += (transcriptBase ? ' ' : '') + text.trim();
//       } else {
//         interim += text;
//       }
//     }
//     $('narasiInput').value = transcriptBase + (interim ? ' ' + interim : '');
//   };

//   recognition.onerror = event => {
//     $('micStatus').textContent = 'Error mikrofon: ' + event.error;
//     stopRecording();
//   };

//   recognition.onend = () => { if (isRecording) recognition.start(); }; // lanjut selama mode rekam
// }

// function toggleMic() {
//   if (!recognition) return;
//   if (isRecording) return stopRecording();

//   transcriptBase = $('narasiInput').value;
//   isRecording = true;
//   recognition.start();
//   $('btnMic').classList.add('recording');
//   $('btnMic').textContent = '⏹ Berhenti Rekam';
//   $('micStatus').textContent = 'Mendengarkan...';
// }

// function stopRecording() {
//   isRecording = false;
//   if (recognition) recognition.stop();
//   $('btnMic').classList.remove('recording');
//   $('btnMic').textContent = '🎤 Rekam Suara';
//   $('micStatus').textContent = '';
// }

// // ============================== SIMPAN KEGIATAN ==============================
// async function saveActivities() {
//   const tanggal = $('tanggalInput').value;
//   const narasi = $('narasiInput').value.trim();

//   if (!tanggal) return setStatus('saveStatus', 'Pilih tanggal dulu.', true);
//   if (!narasi) return setStatus('saveStatus', 'Ceritakan kegiatan Anda dulu.', true);
//   if (isRecording) stopRecording();

//   const btn = $('btnSave');
//   btn.disabled = true;
//   btn.textContent = 'Memproses dengan AI...';
//   setStatus('saveStatus', '');

//   try {
//     const saved = await api('saveActivities', { tanggal, narasi });
//     setStatus('saveStatus', saved.length + ' kegiatan berhasil disimpan.');
//     $('narasiInput').value = '';
//     transcriptBase = '';
//     loadLogs();
//   } catch (err) {
//     setStatus('saveStatus', 'Gagal: ' + err.message, true);
//   } finally {
//     btn.disabled = false;
//     btn.textContent = 'Simpan & Proses dengan AI';
//   }
// }

// // ============================== RIWAYAT HARIAN ==============================
// async function loadLogs() {
//   const listEl = $('logList');
//   listEl.innerHTML = '<div class="empty-state">Memuat...</div>';
//   try {
//     renderLogs(await api('getLogs', { tanggal: $('tanggalInput').value }));
//   } catch (err) {
//     listEl.innerHTML = '<div class="empty-state">Gagal memuat: ' + escapeHtml(err.message) + '</div>';
//   }
// }

// function renderLogs(logs) {
//   const listEl = $('logList');
//   if (!logs.length) {
//     listEl.innerHTML = '<div class="empty-state">Belum ada kegiatan tercatat.</div>';
//     return;
//   }
//   listEl.innerHTML = '';
//   logs.forEach(log => {
//     const div = document.createElement('div');
//     div.className = 'log-item';
//     div.innerHTML =
//       '<span class="tag">' + escapeHtml(log.judulLaporan) + '</span>' +
//       '<div>' + escapeHtml(log.deskripsi) + '</div>' +
//       '<div class="muted">Jml: ' + escapeHtml(log.jml) + ' ' + escapeHtml(log.satuan) + '</div>' +
//       '<a>Hapus</a>';
//     div.querySelector('a').addEventListener('click', () => deleteLog(log.id));
//     listEl.appendChild(div);
//   });
// }

// async function deleteLog(id) {
//   if (!confirm('Hapus kegiatan ini?')) return;
//   try {
//     await api('deleteLog', { id });
//     loadLogs();
//   } catch (err) {
//     alert('Gagal hapus: ' + err.message);
//   }
// }

// // ============================== LAPORAN BULANAN ==============================
// async function generateReport() {
//   const month = $('monthInput').value; // 'yyyy-MM'
//   if (!month) return setStatus('reportStatus', 'Pilih bulan dulu.', true);

//   const btn = $('btnGenerate');
//   btn.disabled = true;
//   btn.textContent = 'Membuat laporan...';
//   setStatus('reportStatus', 'Menyusun laporan & PDF, mohon tunggu...');

//   try {
//     const res = await api('generateReport', { month });
//     $('reportStatus').className = 'status';
//     $('reportStatus').innerHTML = 'Laporan siap! <a href="' + encodeURI(res.pdfUrl) + '" target="_blank" rel="noopener">Buka / Unduh PDF</a>';
//   } catch (err) {
//     setStatus('reportStatus', 'Gagal: ' + err.message, true);
//   } finally {
//     btn.disabled = false;
//     btn.textContent = 'Buat Laporan PDF';
//   }
// }
