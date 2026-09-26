'use strict';

const DB_NAME = 'ledger';
const DB_VERSION = 2;
const STORE = 'entries';
const NOSPEND_STORE = 'noSpend';
const METHODS = ['현금', '카드', '입금'];
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const DEFAULT_CATEGORIES = ['식비', '취미여가비', '여행비', '교통비', '기타'];
const CATEGORY_KEYWORDS = {
  '식비': ['밥', '점심', '저녁', '아침', '식당', '카페', '커피', '치킨', '피자', '배달', '마트', '편의점', '간식', '빵', '술', '고기', '국밥', '분식', '도시락', '디저트'],
  '교통비': ['택시', '버스', '지하철', '전철', '기름', '주유', '톨게이트', '주차', '기차', 'ktx', '대중교통', '환승'],
  '여행비': ['여행', '호텔', '숙박', '항공', '비행기', '펜션', '게스트하우스', '기차표', '여권', '캐리어'],
  '취미여가비': ['영화', '공연', '전시', '게임', '쇼핑', '옷', '화장품', '네일', '헬스', '운동', '책', '콘서트', '미용실', '머리'],
};

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const toKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseKey = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); };
const formatWon = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

let db;
let entries = new Map();
let noSpendDays = new Set();
let categories = loadCategories();
let calendarMonth = today();
let pendingMode = 'add';
let pendingId = null;
let pendingMethod = METHODS[0];
let pendingCategory = categories[0];
let activeDayKey = null;
let toastTimer;
let backupTimer;

function loadCategories() {
  try {
    const raw = localStorage.getItem('ledger-categories');
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) && list.length ? list : [...DEFAULT_CATEGORIES];
  } catch (e) { return [...DEFAULT_CATEGORIES]; }
}
function saveCategories() {
  localStorage.setItem('ledger-categories', JSON.stringify(categories));
}
function loadBudget() {
  const raw = Number(localStorage.getItem('ledger-budget'));
  return raw > 0 ? raw : 200000;
}
function saveBudget(value) {
  localStorage.setItem('ledger-budget', String(value));
}

function guessCategory(memo) {
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (!categories.includes(cat)) continue;
    if (words.some(w => memo.includes(w))) return cat;
  }
  return categories.includes('기타') ? '기타' : categories[categories.length - 1];
}

function parseQuickAmount(raw) {
  let text = raw;
  let total = 0;
  let matched = false;
  const man = text.match(/(\d+(?:\.\d+)?)\s*만/);
  if (man) { total += parseFloat(man[1]) * 10000; matched = true; text = text.replace(man[0], ' '); }
  const cheon = text.match(/(\d+(?:\.\d+)?)\s*천/);
  if (cheon) { total += parseFloat(cheon[1]) * 1000; matched = true; text = text.replace(cheon[0], ' '); }
  if (matched) {
    text = text.replace(/원/g, ' ');
  } else {
    const plain = raw.match(/(\d[\d,]*)\s*원?/);
    if (plain) { total = parseInt(plain[1].replace(/,/g, ''), 10); matched = true; text = raw.replace(plain[0], ' '); }
  }
  if (!matched || !total) return null;
  const memo = text.replace(/\s+/g, ' ').trim();
  return { amount: Math.round(total), memo };
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(NOSPEND_STORE)) database.createObjectStore(NOSPEND_STORE, { keyPath: 'date' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').put(value);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').delete(key);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}

async function loadAll() {
  const list = await idbGetAll(STORE);
  entries = new Map(list.map(e => [e.id, e]));
  const noSpendList = await idbGetAll(NOSPEND_STORE);
  noSpendDays = new Set(noSpendList.map(r => r.date));
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

function entriesOn(dateKey) {
  return Array.from(entries.values()).filter(e => e.date === dateKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function entriesInMonth(year, month) {
  return Array.from(entries.values()).filter(e => { const d = parseKey(e.date); return d.getFullYear() === year && d.getMonth() === month; });
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
      <span class="entry-tags"><span class="entry-category">${escapeHtml(entry.category || '기타')}</span><span class="entry-method">${entry.method}</span></span>
      <span class="entry-main">
        <span class="entry-amount">${formatWon(entry.amount)}</span>
        ${entry.memo ? `<span class="entry-memo">${escapeHtml(entry.memo)}</span>` : ''}
      </span>
      <span class="entry-time">${time}</span>
    </button>`;
}
function escapeHtml(s = '') { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function renderBudget() {
  const budget = loadBudget();
  const y = today().getFullYear(), m = today().getMonth();
  const { sum } = totalsFor(entriesInMonth(y, m));
  const remain = budget - sum;
  const pct = budget > 0 ? Math.min(100, (sum / budget) * 100) : 0;
  $('#budgetFill').style.width = `${pct}%`;
  $('#budgetFill').classList.toggle('over', sum > budget);
  $('#budgetText').textContent = remain >= 0
    ? `${formatWon(budget)} 중 ${formatWon(sum)} 씀 · ${formatWon(remain)} 남음`
    : `${formatWon(budget)} 예산 초과 · ${formatWon(-remain)} 더 썼어요`;
}

function renderHome() {
  const key = toKey(today());
  $('#todayLabel').textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(today());
  const list = entriesOn(key);
  const { sum, totals } = totalsFor(list);
  $('#todayTotal').textContent = formatWon(sum);
  renderBreakdown($('#methodBreakdown'), totals);
  renderBudget();
  const todayList = $('#todayList');
  todayList.innerHTML = list.length ? list.map(entryRow).join('') : '<p class="entry-empty">아직 오늘 기록이 없어요.</p>';
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

  const monthList = entriesInMonth(year, month);
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
    const noSpend = amt === 0 && noSpendDays.has(key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `day-cell${amt > 0 ? ' has-entry' : ''}${key === toKey(today()) ? ' today' : ''}${noSpend ? ' no-spend' : ''}`;
    btn.dataset.date = key;
    const mark = noSpend ? '<span class="day-thumb">👍</span>' : (amt > 0 ? `<span class="day-amt">${(amt / 10000).toFixed(amt % 10000 === 0 ? 0 : 1)}만</span>` : '');
    btn.innerHTML = `<span class="day-num">${day}</span>${mark}`;
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

function renderCategoryPicker() {
  $('#categoryPicker').innerHTML = categories.map(c => `<button type="button" class="${c === pendingCategory ? 'active' : ''}" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
}
function renderMethodPicker() {
  $('#methodPicker').innerHTML = METHODS.map(m => `<button type="button" class="${m === pendingMethod ? 'active' : ''}" data-method="${m}">${m}</button>`).join('');
}

function openEntrySheet(mode, opts = {}) {
  pendingMode = mode;
  pendingId = opts.id || null;
  pendingMethod = opts.method || METHODS[0];
  pendingCategory = opts.category || guessCategory(opts.memo || '') || categories[0];
  $('#sheetTitle').textContent = mode === 'edit' ? '지출 수정' : '지출 추가';
  $('#amountInput').value = opts.amount ?? '';
  $('#dateInput').value = opts.date || toKey(today());
  $('#memoInput').value = opts.memo || '';
  $('#deleteEntry').hidden = mode !== 'edit';
  renderCategoryPicker();
  renderMethodPicker();
  $('#entrySheet').hidden = false;
}
function closeEntrySheet() { $('#entrySheet').hidden = true; }

async function saveEntry() {
  const amount = Number($('#amountInput').value);
  const date = $('#dateInput').value;
  const memo = $('#memoInput').value.trim();
  if (!amount || amount <= 0) { toast('금액을 입력해 주세요.'); return; }
  if (!date) { toast('날짜를 선택해 주세요.'); return; }
  const now = new Date().toISOString();
  const entry = pendingMode === 'edit'
    ? { ...entries.get(pendingId), amount, method: pendingMethod, category: pendingCategory, memo, date, updatedAt: now }
    : { id: uuid(), amount, method: pendingMethod, category: pendingCategory, memo, date, createdAt: now, updatedAt: now };
  await idbPut(STORE, entry);
  entries.set(entry.id, entry);
  if (noSpendDays.has(date)) await clearNoSpend(date);
  closeEntrySheet();
  renderHome();
  renderCalendar();
  if (activeDayKey) renderDaySheet(activeDayKey);
  queueBackup();
  toast(pendingMode === 'edit' ? '수정했어요.' : `기록했어요 (${pendingCategory}로 분류).`);
}

async function deleteEntryConfirmed() {
  if (!pendingId) return;
  await idbDelete(STORE, pendingId);
  entries.delete(pendingId);
  closeEntrySheet();
  renderHome();
  renderCalendar();
  if (activeDayKey) renderDaySheet(activeDayKey);
  queueBackup();
  toast('삭제했어요.');
}

async function clearNoSpend(date) {
  noSpendDays.delete(date);
  await idbDelete(NOSPEND_STORE, date);
}
async function toggleNoSpend() {
  if (!activeDayKey) return;
  if (entriesOn(activeDayKey).length) { toast('이 날은 이미 지출 기록이 있어요.'); return; }
  if (noSpendDays.has(activeDayKey)) {
    await clearNoSpend(activeDayKey);
    toast('무지출 표시를 해제했어요.');
  } else {
    noSpendDays.add(activeDayKey);
    await idbPut(NOSPEND_STORE, { date: activeDayKey, markedAt: new Date().toISOString() });
    toast('무지출 날로 표시했어요 👍');
  }
  renderCalendar();
  renderDaySheet(activeDayKey);
  queueBackup();
}

function renderDaySheet(key) {
  activeDayKey = key;
  const date = parseKey(key);
  $('#daySheetTitle').textContent = `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAY[date.getDay()]}요일`;
  const list = entriesOn(key);
  $('#dayList').innerHTML = list.length ? list.map(entryRow).join('') : '<p class="entry-empty">이 날 기록이 없어요.</p>';
  const noSpendBtn = $('#toggleNoSpend');
  noSpendBtn.hidden = list.length > 0;
  noSpendBtn.textContent = noSpendDays.has(key) ? '👍 무지출 표시 해제' : '👍 이 날은 무지출로 표시';
  noSpendBtn.classList.toggle('active', noSpendDays.has(key));
  $('#daySheet').hidden = false;
}
function closeDaySheet() { $('#daySheet').hidden = true; activeDayKey = null; }

function renderCategoryManageList() {
  $('#categoryManageList').innerHTML = categories.map((c, i) => `
    <div class="category-manage-row" data-index="${i}">
      <input type="text" value="${escapeHtml(c)}" class="category-name-input">
      <button type="button" class="category-delete" aria-label="삭제">×</button>
    </div>
  `).join('');
}
function openCategorySheet() { renderCategoryManageList(); $('#categorySheet').hidden = false; }
function closeCategorySheet() {
  const rows = $$('.category-manage-row');
  const updated = rows.map(r => r.querySelector('.category-name-input').value.trim()).filter(Boolean);
  categories = updated.length ? updated : [...DEFAULT_CATEGORIES];
  saveCategories();
  $('#categorySheet').hidden = true;
  renderCategoryPicker();
}
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function switchScreen(name) {
  $('#home-screen').hidden = name !== 'home';
  $('#calendar-screen').hidden = name !== 'calendar';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
  if (name === 'calendar') renderCalendar();
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchScreen(t.dataset.screen)));
  $('#addButton').addEventListener('click', () => openEntrySheet('add', { date: toKey(today()) }));

  $('#quickForm').addEventListener('submit', async e => {
    e.preventDefault();
    const raw = $('#quickInput').value.trim();
    if (!raw) return;
    const parsed = parseQuickAmount(raw);
    if (!parsed) { toast('금액을 못 찾았어요. 예: 택시 3만원'); return; }
    const category = guessCategory(parsed.memo);
    const now = new Date().toISOString();
    const entry = { id: uuid(), amount: parsed.amount, method: pendingMethod || METHODS[0], category, memo: parsed.memo, date: toKey(today()), createdAt: now, updatedAt: now };
    await idbPut(STORE, entry);
    entries.set(entry.id, entry);
    $('#quickInput').value = '';
    renderHome();
    queueBackup();
    toast(`${formatWon(parsed.amount)} 기록했어요 (${category}).`);
  });

  $('#budgetCard').addEventListener('click', () => {
    $('#budgetInput').value = loadBudget();
    $('#budgetSheet').hidden = false;
  });
  $('#cancelBudget').addEventListener('click', () => { $('#budgetSheet').hidden = true; });
  $('#saveBudget').addEventListener('click', () => {
    const value = Number($('#budgetInput').value);
    if (!value || value <= 0) { toast('금액을 입력해 주세요.'); return; }
    saveBudget(value);
    $('#budgetSheet').hidden = true;
    renderBudget();
    toast('생활비를 저장했어요.');
  });

  $('#categoryPicker').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    pendingCategory = btn.dataset.category;
    renderCategoryPicker();
  });
  $('#manageCategories').addEventListener('click', openCategorySheet);
  $('#closeCategorySheet').addEventListener('click', closeCategorySheet);
  $('#categoryManageList').addEventListener('click', e => {
    if (!e.target.closest('.category-delete')) return;
    e.target.closest('.category-manage-row').remove();
  });
  $('#addCategoryForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#newCategoryInput').value.trim();
    if (!name) return;
    const row = document.createElement('div');
    row.className = 'category-manage-row';
    row.innerHTML = `<input type="text" value="${escapeHtml(name)}" class="category-name-input"><button type="button" class="category-delete" aria-label="삭제">×</button>`;
    $('#categoryManageList').append(row);
    $('#newCategoryInput').value = '';
  });

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
  $('#toggleNoSpend').addEventListener('click', toggleNoSpend);
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

function queueBackup() {
  // Fires shortly after any add/edit/delete/no-spend toggle (debounced), not just once a day --
  // a same-day bulletjournal digest read needs today's edits to actually be on the server.
  clearTimeout(backupTimer);
  backupTimer = setTimeout(runBackup, 1500);
}
async function runBackup() {
  try {
    const payload = { entries: Array.from(entries.values()), noSpend: Array.from(noSpendDays) };
    await fetch('https://appointee-unnoticed-donated.ngrok-free.dev/api/app-backup/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
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
  queueBackup();
}

init();
