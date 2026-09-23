'use strict';

const DB_NAME = 'ledger';
const DB_VERSION = 1;
const STORE = 'entries';
const METHODS = ['현금', '카드', '입금'];
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const toKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseKey = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); };
const formatWon = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

let db;
let entries = new Map();
let calendarMonth = today();
let pendingMode = 'add';
let pendingId = null;
let pendingMethod = METHODS[0];
let activeDayKey = null;
let toastTimer;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(mode = 'readonly') { return db.transaction(STORE, mode).objectStore(STORE); }
function idbGetAll() {
  return new Promise((resolve, reject) => {
    const req = tx().getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(value) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').put(value);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(id) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').delete(id);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}

async function loadAll() {
  const list = await idbGetAll();
  entries = new Map(list.map(e => [e.id, e]));
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function entriesOn(dateKey) {
  return Array.from(entries.values()).filter(e => e.date === dateKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function totalsFor(list) {
  const totals = { 현금: 0, 카드: 0, 입금: 0 };
  let sum = 0;
  for (const e of list) { totals[e.method] = (totals[e.method] || 0) + e.amount; sum += e.amount; }
  return { sum, totals };
}

function renderBreakdown(el, totals) {
  el.innerHTML = METHODS.map(m => `<span class="method-chip"><b>${m}</b>${formatWon(totals[m] || 0)}</span>`).join('');
}

function entryRow(entry) {
  const time = entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
  return `
    <button class="entry-row" type="button" data-id="${entry.id}">
      <span class="entry-method">${entry.method}</span>
      <span class="entry-main">
        <span class="entry-amount">${formatWon(entry.amount)}</span>
        ${entry.memo ? `<span class="entry-memo">${escapeHtml(entry.memo)}</span>` : ''}
      </span>
      <span class="entry-time">${time}</span>
    </button>`;
}
function escapeHtml(s = '') { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function renderHome() {
  const key = toKey(today());
  $('#todayLabel').textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(today());
  const list = entriesOn(key);
  const { sum, totals } = totalsFor(list);
  $('#todayTotal').textContent = formatWon(sum);
  renderBreakdown($('#methodBreakdown'), totals);
  const todayList = $('#todayList');
  if (!list.length) {
    todayList.innerHTML = '<p class="entry-empty">아직 오늘 기록이 없어요.</p>';
  } else {
    todayList.innerHTML = list.map(entryRow).join('');
  }
}

function weekRangesOf(year, month) {
  const last = new Date(year, month + 1, 0).getDate();
  const ranges = [];
  let d = 1;
  while (d <= last) {
    const start = new Date(year, month, d, 12);
    const daysToSat = 6 - start.getDay();
    const endDay = Math.min(d + daysToSat, last);
    const end = new Date(year, month, endDay, 12);
    ranges.push({ start, end });
    d = endDay + 1;
  }
  return ranges;
}

function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  $('#calendarTitle').textContent = `${year}년 ${month + 1}월`;
  const first = new Date(year, month, 1, 12);
  const last = new Date(year, month + 1, 0, 12);

  const monthList = Array.from(entries.values()).filter(e => {
    const d = parseKey(e.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });
  const { sum: monthSum } = totalsFor(monthList);
  $('#monthSummary').textContent = `이 달 합계 ${formatWon(monthSum)}`;

  const dayTotals = new Map();
  for (const e of monthList) dayTotals.set(e.date, (dayTotals.get(e.date) || 0) + e.amount);

  const grid = $('#calendarGrid');
  grid.innerHTML = '';
  for (let i = 0; i < first.getDay(); i++) grid.append(document.createElement('span'));
  for (let day = 1; day <= last.getDate(); day++) {
    const date = new Date(year, month, day, 12);
    const key = toKey(date);
    const amt = dayTotals.get(key) || 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `day-cell${amt > 0 ? ' has-entry' : ''}${key === toKey(today()) ? ' today' : ''}`;
    btn.dataset.date = key;
    btn.innerHTML = `<span class="day-num">${day}</span>${amt > 0 ? `<span class="day-amt">${(amt / 10000).toFixed(amt % 10000 === 0 ? 0 : 1)}만</span>` : ''}`;
    grid.append(btn);
  }

  const weekWrap = $('#weekSummary');
  const ranges = weekRangesOf(year, month);
  weekWrap.innerHTML = ranges.map(({ start, end }) => {
    const list = monthList.filter(e => { const d = parseKey(e.date); return d >= start && d <= end; });
    const { sum } = totalsFor(list);
    const label = start.getDate() === end.getDate()
      ? `${month + 1}/${start.getDate()}`
      : `${month + 1}/${start.getDate()}~${month + 1}/${end.getDate()}`;
    return `<div class="week-row"><span>${label}</span><b>${formatWon(sum)}</b></div>`;
  }).join('');
}

function openEntrySheet(mode, opts = {}) {
  pendingMode = mode;
  pendingId = opts.id || null;
  pendingMethod = opts.method || METHODS[0];
  $('#sheetTitle').textContent = mode === 'edit' ? '지출 수정' : '지출 추가';
  $('#amountInput').value = opts.amount ?? '';
  $('#dateInput').value = opts.date || toKey(today());
  $('#memoInput').value = opts.memo || '';
  $('#deleteEntry').hidden = mode !== 'edit';
  renderMethodPicker();
  $('#entrySheet').hidden = false;
}
function closeEntrySheet() { $('#entrySheet').hidden = true; }

function renderMethodPicker() {
  $('#methodPicker').innerHTML = METHODS.map(m => `<button type="button" class="${m === pendingMethod ? 'active' : ''}" data-method="${m}">${m}</button>`).join('');
}

async function saveEntry() {
  const amount = Number($('#amountInput').value);
  const date = $('#dateInput').value;
  const memo = $('#memoInput').value.trim();
  if (!amount || amount <= 0) { toast('금액을 입력해 주세요.'); return; }
  if (!date) { toast('날짜를 선택해 주세요.'); return; }
  const now = new Date().toISOString();
  const entry = pendingMode === 'edit'
    ? { ...entries.get(pendingId), amount, method: pendingMethod, memo, date, updatedAt: now }
    : { id: uuid(), amount, method: pendingMethod, memo, date, createdAt: now, updatedAt: now };
  await idbPut(entry);
  entries.set(entry.id, entry);
  closeEntrySheet();
  renderHome();
  renderCalendar();
  if (activeDayKey) renderDaySheet(activeDayKey);
  toast(pendingMode === 'edit' ? '수정했어요.' : '기록했어요.');
}

async function deleteEntryConfirmed() {
  if (!pendingId) return;
  await idbDelete(pendingId);
  entries.delete(pendingId);
  closeEntrySheet();
  renderHome();
  renderCalendar();
  if (activeDayKey) renderDaySheet(activeDayKey);
  toast('삭제했어요.');
}

function renderDaySheet(key) {
  activeDayKey = key;
  const date = parseKey(key);
  $('#daySheetTitle').textContent = `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAY[date.getDay()]}요일`;
  const list = entriesOn(key);
  $('#dayList').innerHTML = list.length ? list.map(entryRow).join('') : '<p class="entry-empty">이 날 기록이 없어요.</p>';
  $('#daySheet').hidden = false;
}
function closeDaySheet() { $('#daySheet').hidden = true; activeDayKey = null; }

function switchScreen(name) {
  $('#home-screen').hidden = name !== 'home';
  $('#calendar-screen').hidden = name !== 'calendar';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
  if (name === 'calendar') renderCalendar();
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchScreen(t.dataset.screen)));
  $('#addButton').addEventListener('click', () => openEntrySheet('add', { date: toKey(today()) }));
  $('#methodPicker').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    pendingMethod = btn.dataset.method;
    renderMethodPicker();
  });
  $('#cancelEntry').addEventListener('click', closeEntrySheet);
  $('#saveEntry').addEventListener('click', saveEntry);
  $('#deleteEntry').addEventListener('click', deleteEntryConfirmed);

  $('#todayList').addEventListener('click', e => {
    const row = e.target.closest('.entry-row');
    if (!row) return;
    const entry = entries.get(row.dataset.id);
    if (entry) openEntrySheet('edit', entry);
  });

  $('#calendarGrid').addEventListener('click', e => {
    const cell = e.target.closest('.day-cell');
    if (cell) renderDaySheet(cell.dataset.date);
  });
  $('#dayList').addEventListener('click', e => {
    const row = e.target.closest('.entry-row');
    if (!row) return;
    const entry = entries.get(row.dataset.id);
    if (entry) openEntrySheet('edit', entry);
  });
  $('#closeDaySheet').addEventListener('click', closeDaySheet);
  $('#addForDay').addEventListener('click', () => openEntrySheet('add', { date: activeDayKey || toKey(today()) }));

  $('#prevMonth').addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1, 12); renderCalendar(); });
  $('#nextMonth').addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1, 12); renderCalendar(); });
  let sx = 0;
  $('#calendarGrid').addEventListener('touchstart', e => { sx = e.changedTouches[0].clientX; }, { passive: true });
  $('#calendarGrid').addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) < 55) return;
    (dx < 0 ? $('#nextMonth') : $('#prevMonth')).click();
  }, { passive: true });
}

async function dailyBackup() {
  try {
    const key = toKey(today());
    if (localStorage.getItem('ledger-backup-date') === key) return;
    const res = await fetch('https://appointee-unnoticed-donated.ngrok-free.dev/api/app-backup/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.from(entries.values())),
    });
    if (res.ok) localStorage.setItem('ledger-backup-date', key);
  } catch (e) { /* best effort */ }
}

async function init() {
  bindEvents();
  try {
    db = await openDB();
    await loadAll();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { /* IndexedDB unavailable */ }
  renderHome();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(reg => reg.update()).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
  }
  setTimeout(dailyBackup, 3500);
}

init();
