/*
 * app.js - Task management UI wired to a CalDAV backend.
 */
(function () {
  'use strict';

  const CFG_KEY = 'tasklist.config';
  const STATE_KEY = 'tasklist.state';
  const ALL = '__all__';

  // ---- App state -------------------------------------------------------
  const state = {
    config: null,          // { url, username, password, interval }
    client: null,          // CalDAV instance
    collections: [],       // [{ url, displayName, ctag, color }]
    tasks: {},             // collectionURL -> [task...]
    currentList: ALL,      // ALL or a collection URL
    lastUsedCollection: null,
    showCompleted: false,
    pollTimer: null,
    loading: false,
  };

  const $ = (id) => document.getElementById(id);

  // ---- Persistence -----------------------------------------------------
  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch (e) { return null; }
  }
  function saveConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
  function clearConfig() { localStorage.removeItem(CFG_KEY); }

  function loadUIState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveUIState() {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      currentList: state.currentList,
      lastUsedCollection: state.lastUsedCollection,
      showCompleted: state.showCompleted,
    }));
  }

  // ---- Date helpers ----------------------------------------------------
  function startOfToday() {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }
  function isOverdue(task) {
    if (!task.due || task.completed) return false;
    if (task.dueDateOnly) {
      // Date-only due: overdue once the day has fully passed.
      const end = new Date(task.due); end.setHours(23, 59, 59, 999);
      return end < new Date();
    }
    return task.due < new Date();
  }
  function formatDueBadge(task) {
    const due = task.due;
    const today = startOfToday();
    const d0 = new Date(due); d0.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d0 - today) / 86400000);
    let label;
    if (diffDays === 0) label = 'Today';
    else if (diffDays === 1) label = 'Tomorrow';
    else if (diffDays === -1) label = 'Yesterday';
    else {
      const opts = { month: 'short', day: 'numeric' };
      if (due.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
      label = due.toLocaleDateString(undefined, opts);
    }
    if (!task.dueDateOnly) {
      label += ', ' + due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return label;
  }
  function formatFullDate(date, dateOnly) {
    if (dateOnly) return date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
    return date.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function repeatText(rrule) {
    if (!rrule || !rrule.FREQ) return null;
    const interval = parseInt(rrule.INTERVAL, 10) || 1;
    const unitMap = { DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'] };
    const u = unitMap[rrule.FREQ.toUpperCase()];
    if (!u) return 'Repeats';
    let txt = interval === 1 ? 'Every ' + u[0] : 'Every ' + interval + ' ' + u[1];
    if (rrule.COUNT) txt += ' ×' + rrule.COUNT;
    else if (rrule.UNTIL) {
      const d = ICAL.parseDate(rrule.UNTIL, {});
      if (d.date) txt += ' until ' + d.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return txt;
  }

  // ---- SVG snippets ----------------------------------------------------
  const SVG = {
    check: '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    flag: '<svg class="flag" viewBox="0 0 24 24"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zm0 16H5V10h14zm0-12H5V6h14z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  };

  // ---- Sorting ---------------------------------------------------------
  // 1. Overdue first, by priority then due date.
  // 2. Remaining, by priority then due date.
  function sortTasks(list) {
    return list.slice().sort(function (a, b) {
      const ao = isOverdue(a), bo = isOverdue(b);
      if (ao !== bo) return ao ? -1 : 1;

      const pr = ICAL.priorityRank(b.priority) - ICAL.priorityRank(a.priority);
      if (pr !== 0) return pr;

      // Due date ascending; tasks without a due date sort last.
      const at = a.due ? a.due.getTime() : Infinity;
      const bt = b.due ? b.due.getTime() : Infinity;
      if (at !== bt) return at - bt;

      return (a.summary || '').localeCompare(b.summary || '');
    });
  }

  function currentTasks() {
    let list = [];
    if (state.currentList === ALL) {
      Object.keys(state.tasks).forEach((url) => { list = list.concat(state.tasks[url]); });
    } else {
      list = (state.tasks[state.currentList] || []).slice();
    }
    return list;
  }

  // ---- Rendering: sidebar ---------------------------------------------
  function countActive(url) {
    const list = url === ALL ? currentTasksAll() : (state.tasks[url] || []);
    return list.filter((t) => !t.completed).length;
  }
  function currentTasksAll() {
    let list = [];
    Object.keys(state.tasks).forEach((url) => { list = list.concat(state.tasks[url]); });
    return list;
  }

  function renderSidebar() {
    const nav = $('listNav');
    nav.innerHTML = '';

    const items = [{ url: ALL, displayName: 'All Tasks', color: null }].concat(state.collections);
    items.forEach((col) => {
      const btn = document.createElement('button');
      btn.className = 'list-item' + (state.currentList === col.url ? ' active' : '');
      const active = countActive(col.url);
      const dotColor = col.color ? ('style="background:' + col.color + '"') : '';
      btn.innerHTML =
        '<span class="dot" ' + dotColor + '></span>' +
        '<span class="name"></span>' +
        (active ? '<span class="count">' + active + '</span>' : '');
      btn.querySelector('.name').textContent = col.displayName;
      btn.addEventListener('click', () => {
        state.currentList = col.url;
        saveUIState();
        renderSidebar();
        renderTasks();
        updateTitle();
        if (window.innerWidth < 840) document.body.classList.remove('sidebar-open');
      });
      nav.appendChild(btn);
    });
  }

  function updateTitle() {
    let name = 'All Tasks';
    if (state.currentList !== ALL) {
      const c = state.collections.find((x) => x.url === state.currentList);
      name = c ? c.displayName : 'Tasks';
    }
    $('appTitle').textContent = name;
  }

  // ---- Rendering: task list -------------------------------------------
  function makeTaskEl(task) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.completed ? ' done' : '');
    li.dataset.uid = task.uid;
    li.dataset.href = task.href || '';

    // Checkbox
    const check = document.createElement('button');
    check.className = 'check';
    check.innerHTML = SVG.check;
    check.title = task.completed ? 'Mark not done' : 'Mark done';
    check.addEventListener('click', (e) => { e.stopPropagation(); toggleComplete(task); });
    li.appendChild(check);

    // Main (title + badges)
    const main = document.createElement('div');
    main.className = 'task-main';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.summary || '(No title)';
    main.appendChild(title);

    const badges = document.createElement('div');
    badges.className = 'badges';
    if (task.due) {
      const b = document.createElement('span');
      b.className = 'badge' + (isOverdue(task) ? ' overdue' : '');
      b.innerHTML = SVG.calendar + '<span></span>';
      b.querySelector('span').textContent = formatDueBadge(task);
      badges.appendChild(b);
    }
    const rep = repeatText(task.rrule);
    if (rep) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.innerHTML = SVG.repeat + '<span></span>';
      b.querySelector('span').textContent = rep;
      badges.appendChild(b);
    }
    if (badges.children.length) main.appendChild(badges);

    main.addEventListener('click', () => openDetail(task));
    li.appendChild(main);

    // Priority indicator
    const pri = document.createElement('button');
    pri.className = 'pri-indicator';
    pri.dataset.pri = task.priority;
    pri.innerHTML = SVG.flag;
    pri.title = 'Priority: ' + task.priority;
    pri.addEventListener('click', (e) => { e.stopPropagation(); cyclePriority(task); });
    li.appendChild(pri);

    return li;
  }

  function renderTasks() {
    const all = currentTasks();
    const active = sortTasks(all.filter((t) => !t.completed));
    const completed = all.filter((t) => t.completed)
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

    const listEl = $('taskList');
    listEl.innerHTML = '';
    active.forEach((t) => listEl.appendChild(makeTaskEl(t)));

    // Completed section
    const compBtn = $('toggleCompletedBtn');
    if (completed.length) {
      compBtn.classList.remove('hidden');
      compBtn.textContent = (state.showCompleted ? 'Hide' : 'Show') + ' completed (' + completed.length + ')';
    } else {
      compBtn.classList.add('hidden');
    }
    const compSection = $('completedSection');
    const compList = $('completedList');
    compList.innerHTML = '';
    if (state.showCompleted && completed.length) {
      compSection.classList.remove('hidden');
      completed.forEach((t) => compList.appendChild(makeTaskEl(t)));
    } else {
      compSection.classList.add('hidden');
    }

    // Empty state
    $('emptyState').classList.toggle('hidden', active.length > 0 || (state.showCompleted && completed.length > 0));
  }

  // ---- Task mutations --------------------------------------------------
  function findTaskByUid(uid) {
    for (const url of Object.keys(state.tasks)) {
      const t = state.tasks[url].find((x) => x.uid === uid);
      if (t) return t;
    }
    return null;
  }

  async function pushTask(task) {
    // Serialize and PUT. Updates etag on success.
    task.lastModified = ICAL.nowStamp();
    const ics = ICAL.buildTodo(task);
    try {
      setSync('syncing');
      const res = await state.client.putTodo(task.href, ics, task.etag);
      if (res.etag) task.etag = res.etag;
      setSync('ok');
    } catch (e) {
      setSync('error');
      showBanner('Could not save changes: ' + e.message);
      // Re-sync to reconcile.
      pollNow();
    }
  }

  const PRI_CYCLE = ['none', 'low', 'medium', 'high'];
  function cyclePriority(task) {
    const idx = PRI_CYCLE.indexOf(task.priority);
    task.priority = PRI_CYCLE[(idx + 1) % PRI_CYCLE.length];
    renderTasks();
    pushTask(task);
  }

  function toggleComplete(task) {
    if (!task.completed) {
      // If recurring, roll to the next occurrence instead of completing.
      if (task.rrule && task.rrule.FREQ && rollRecurrence(task)) {
        renderTasks();
        renderSidebar();
        pushTask(task);
        return;
      }
      task.completed = true;
      task.status = 'COMPLETED';
      task.completedAt = ICAL.nowStamp();
    } else {
      task.completed = false;
      task.status = 'NEEDS-ACTION';
      task.completedAt = null;
    }
    renderTasks();
    renderSidebar();
    pushTask(task);
  }

  // Advance a recurring task to its next occurrence.
  // Returns true if it rolled forward; false if the series is finished
  // (caller should then complete it).
  function rollRecurrence(task) {
    const rule = task.rrule;
    const base = task.due || task.dtstart;
    if (!base) return false;

    const next = ICAL.advanceDate(base, rule);
    if (!next) return false;

    // COUNT handling: decrement; finish when exhausted.
    if (rule.COUNT !== undefined) {
      const c = parseInt(rule.COUNT, 10);
      if (c <= 1) return false; // this was the last occurrence
      rule.COUNT = String(c - 1);
    }
    // UNTIL handling: finish if next is past the end date.
    if (rule.UNTIL) {
      const until = ICAL.parseDate(rule.UNTIL, {});
      if (until.date && next > until.date) return false;
    }

    if (task.due) task.due = next;
    if (task.dtstart) {
      // Keep dtstart offset relative to due if both existed.
      task.dtstart = ICAL.advanceDate(task.dtstart, rule);
    }
    return true;
  }

  // ---- Detail view -----------------------------------------------------
  let detailTask = null;
  function openDetail(task) {
    detailTask = task;
    const body = $('detailBody');
    const rows = [];
    rows.push('<div class="detail-title"></div>');

    const priClass = task.priority;
    const priLabel = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
    rows.push(row('Priority', '<span class="detail-pri-chip ' + priClass + '">' + SVG.flag + priLabel + '</span>'));

    if (task.due) {
      rows.push(row('Due', '<span class="value ' + (isOverdue(task) ? 'overdue' : '') + '">' +
        escapeHtml(formatFullDate(task.due, task.dueDateOnly)) + '</span>', true));
    }
    const rep = repeatText(task.rrule);
    if (rep) rows.push(row('Repeat', escapeHtml(rep)));
    if (task.description) rows.push(row('Details', escapeHtml(task.description)));

    const colName = task._collectionName || collectionName(task._collectionURL);
    if (colName) rows.push(row('List', escapeHtml(colName)));
    if (task.completed) rows.push(row('Status', 'Completed'));

    body.innerHTML = rows.join('');
    body.querySelector('.detail-title').textContent = task.summary || '(No title)';
    show('detailModal');
  }
  function row(label, valueHtml, raw) {
    const val = raw ? valueHtml : '<span class="value">' + valueHtml + '</span>';
    return '<div class="detail-row"><span class="label">' + label + '</span>' + val + '</div>';
  }
  function collectionName(url) {
    const c = state.collections.find((x) => x.url === url);
    return c ? c.displayName : '';
  }

  // ---- Add / Edit form -------------------------------------------------
  let editingTask = null; // null => add mode
  let formPriority = 'none';

  function setFormPriority(p) {
    formPriority = p;
    document.querySelectorAll('#fPriority .pri-opt').forEach((el) => {
      el.classList.toggle('selected', el.dataset.pri === p);
    });
  }

  function openForm(task) {
    editingTask = task || null;
    $('formTitle').textContent = task ? 'Edit task' : 'Add a task';
    hideEl('formError');

    // Populate list dropdown
    const sel = $('fList');
    sel.innerHTML = '';
    state.collections.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.url; o.textContent = c.displayName;
      sel.appendChild(o);
    });

    if (task) {
      $('fTitle').value = task.summary || '';
      setFormPriority(task.priority);
      $('fDue').value = task.due ? toDateInput(task.due) : '';
      $('fDesc').value = task.description || '';
      sel.value = task._collectionURL;
      loadRepeatForm(task.rrule);
    } else {
      $('fTitle').value = '';
      setFormPriority('none');
      $('fDue').value = '';
      $('fDesc').value = '';
      sel.value = state.lastUsedCollection ||
        (state.currentList !== ALL ? state.currentList : (state.collections[0] && state.collections[0].url));
      loadRepeatForm(null);
    }
    show('formModal');
    setTimeout(() => $('fTitle').focus(), 50);
  }

  function loadRepeatForm(rrule) {
    const on = !!(rrule && rrule.FREQ);
    $('fRepeatOn').checked = on;
    $('repeatDetails').classList.toggle('hidden', !on);
    if (on) {
      $('fRepeatInterval').value = parseInt(rrule.INTERVAL, 10) || 1;
      $('fRepeatFreq').value = rrule.FREQ.toUpperCase();
      if (rrule.COUNT) {
        $('fRepeatEnd').value = 'count';
        $('fRepeatCount').value = rrule.COUNT;
      } else if (rrule.UNTIL) {
        $('fRepeatEnd').value = 'until';
        const d = ICAL.parseDate(rrule.UNTIL, {});
        if (d.date) $('fRepeatUntil').value = toDateInput(d.date);
      } else {
        $('fRepeatEnd').value = 'never';
      }
    } else {
      $('fRepeatFreq').value = 'WEEKLY';
      $('fRepeatInterval').value = 1;
      $('fRepeatEnd').value = 'never';
    }
    syncRepeatVisibility();
  }
  function syncRepeatVisibility() {
    const end = $('fRepeatEnd').value;
    $('repeatUntilLine').classList.toggle('hidden', end !== 'until');
    $('repeatCountLine').classList.toggle('hidden', end !== 'count');
  }

  function buildRRuleFromForm() {
    if (!$('fRepeatOn').checked) return null;
    const rule = { FREQ: $('fRepeatFreq').value, INTERVAL: String(parseInt($('fRepeatInterval').value, 10) || 1) };
    const end = $('fRepeatEnd').value;
    if (end === 'until' && $('fRepeatUntil').value) {
      const d = fromDateInput($('fRepeatUntil').value);
      rule.UNTIL = ICAL.formatDate(d, true).slice(0, 8) + 'T235959Z';
    } else if (end === 'count' && $('fRepeatCount').value) {
      rule.COUNT = String(parseInt($('fRepeatCount').value, 10) || 1);
    }
    return rule;
  }

  async function saveForm() {
    const title = $('fTitle').value.trim();
    if (!title) { showFormError('Please enter a title.'); return; }
    const colURL = $('fList').value;
    if (!colURL) { showFormError('Please choose a task list.'); return; }

    const dueVal = $('fDue').value;
    const due = dueVal ? fromDateInput(dueVal) : null;
    const rrule = buildRRuleFromForm();

    let task = editingTask;
    const movingList = task && task._collectionURL !== colURL;

    if (!task) {
      task = {
        uid: ICAL.generateUID(),
        created: ICAL.nowStamp(),
        completed: false,
        status: 'NEEDS-ACTION',
        _extra: {},
      };
    }
    task.summary = title;
    task.priority = formPriority;
    task.due = due;
    task.dueDateOnly = !!due;
    task.description = $('fDesc').value.trim();
    task.rrule = rrule;

    state.lastUsedCollection = colURL;
    saveUIState();

    hide('formModal');
    setSync('syncing');
    try {
      if (!editingTask) {
        // New task.
        task._collectionURL = colURL;
        task._collectionName = collectionName(colURL);
        task.href = colURL.replace(/\/?$/, '/') + task.uid + '.ics';
        const res = await state.client.putTodo(task.href, ICAL.buildTodo(task), null);
        if (res.etag) task.etag = res.etag;
        (state.tasks[colURL] = state.tasks[colURL] || []).push(task);
      } else if (movingList) {
        // Moved to a different list: create in new, delete from old.
        const oldHref = task.href, oldEtag = task.etag, oldURL = task._collectionURL;
        task._collectionURL = colURL;
        task._collectionName = collectionName(colURL);
        task.href = colURL.replace(/\/?$/, '/') + task.uid + '.ics';
        task.etag = null;
        const res = await state.client.putTodo(task.href, ICAL.buildTodo(task), null);
        if (res.etag) task.etag = res.etag;
        await state.client.deleteTodo(oldHref, oldEtag);
        state.tasks[oldURL] = (state.tasks[oldURL] || []).filter((t) => t.uid !== task.uid);
        (state.tasks[colURL] = state.tasks[colURL] || []).push(task);
      } else {
        await pushTask(task);
      }
      setSync('ok');
    } catch (e) {
      setSync('error');
      showBanner('Could not save task: ' + e.message);
    }
    renderTasks();
    renderSidebar();
  }

  async function deleteTask(task) {
    hide('detailModal');
    setSync('syncing');
    try {
      await state.client.deleteTodo(task.href, task.etag);
      state.tasks[task._collectionURL] = (state.tasks[task._collectionURL] || []).filter((t) => t.uid !== task.uid);
      setSync('ok');
    } catch (e) {
      setSync('error');
      showBanner('Could not delete task: ' + e.message);
    }
    renderTasks();
    renderSidebar();
  }

  // ---- Date input helpers ---------------------------------------------
  function toDateInput(date) {
    const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }
  function fromDateInput(val) {
    const [y, m, d] = val.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // ---- Data loading & sync --------------------------------------------
  function augment(items, col) {
    // Turn raw {href, etag, data} into task objects with collection info.
    const out = [];
    items.forEach((it) => {
      const t = ICAL.parseTodo(it.data);
      if (!t) return;
      t.href = it.href;
      t.etag = it.etag;
      t._collectionURL = col.url;
      t._collectionName = col.displayName;
      out.push(t);
    });
    return out;
  }

  async function initialLoad() {
    setSync('syncing');
    showBanner('Connecting…', false);
    try {
      state.collections = await state.client.discoverCollections();
      if (!state.collections.length) {
        showBanner('No task lists (VTODO calendars) found on the server.');
        setSync('error');
        return;
      }
      hideBanner();
      // Fetch all collections in parallel.
      await Promise.all(state.collections.map(async (col) => {
        const items = await state.client.fetchTodos(col.url);
        state.tasks[col.url] = augment(items, col);
        col.ctag = await safeCtag(col.url);
        // If the server has no getctag, establish an etag-signature baseline.
        if (!col.ctag) {
          try { col._sig = await state.client.fetchSignature(col.url); } catch (e) { col._sig = null; }
        }
      }));

      // Restore current list if still valid.
      if (state.currentList !== ALL && !state.collections.find((c) => c.url === state.currentList)) {
        state.currentList = ALL;
      }
      if (!state.lastUsedCollection || !state.collections.find((c) => c.url === state.lastUsedCollection)) {
        state.lastUsedCollection = state.collections[0].url;
      }

      renderSidebar();
      renderTasks();
      updateTitle();
      setSync('ok');
      startPolling();
    } catch (e) {
      setSync('error');
      showBanner('Connection failed: ' + e.message + '  — check the URL, credentials, and that the server allows CORS.');
    }
  }

  async function safeCtag(url) {
    try { return await state.client.getCtag(url); } catch (e) { return null; }
  }

  function startPolling() {
    stopPolling();
    const interval = Math.max(2, parseInt(state.config.interval, 10) || 5) * 1000;
    state.pollTimer = setInterval(pollNow, interval);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  let polling = false;
  async function pollNow() {
    if (polling || !state.client) return;
    polling = true;
    try {
      let changed = false;
      for (const col of state.collections) {
        let dirty = false;
        const ctag = await safeCtag(col.url);
        if (ctag) {
          // Server supports getctag: cheapest possible check.
          if (ctag !== col.ctag) { dirty = true; col.ctag = ctag; }
        } else {
          // Fallback: compare an etag signature (works on any CalDAV server).
          try {
            const sig = await state.client.fetchSignature(col.url);
            if (sig !== col._sig) { dirty = true; col._sig = sig; }
          } catch (e) { /* leave as-is; try again next tick */ }
        }
        if (dirty) {
          const items = await state.client.fetchTodos(col.url);
          state.tasks[col.url] = augment(items, col);
          changed = true;
        }
      }
      if (changed) {
        // Preserve open modals; just refresh the visible list.
        renderSidebar();
        renderTasks();
      }
      setSync('ok');
    } catch (e) {
      setSync('error');
    } finally {
      polling = false;
    }
  }

  // ---- UI helpers ------------------------------------------------------
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function hideEl(id) { $(id).classList.add('hidden'); }
  function setSync(status) {
    const el = $('syncIndicator');
    el.className = 'sync-indicator ' + status;
    el.title = 'Sync: ' + status;
  }
  function showBanner(msg, isError) {
    const b = $('statusBanner');
    b.textContent = msg;
    b.classList.remove('hidden');
    b.style.background = (isError === false) ? '#e8f0fe' : '#fce8e6';
    b.style.color = (isError === false) ? '#1a73e8' : '#d93025';
  }
  function hideBanner() { $('statusBanner').classList.add('hidden'); }
  function showFormError(msg) { const e = $('formError'); e.textContent = msg; e.classList.remove('hidden'); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Confirm dialog (promise-based)
  function confirmDialog(title, msg, okLabel) {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title;
      $('confirmMsg').textContent = msg;
      $('confirmOk').textContent = okLabel || 'Delete';
      show('confirmModal');
      const cleanup = (val) => {
        hide('confirmModal');
        $('confirmOk').removeEventListener('click', ok);
        $('confirmCancel').removeEventListener('click', cancel);
        resolve(val);
      };
      const ok = () => cleanup(true);
      const cancel = () => cleanup(false);
      $('confirmOk').addEventListener('click', ok);
      $('confirmCancel').addEventListener('click', cancel);
    });
  }

  // ---- Settings --------------------------------------------------------
  function openSettings() {
    const cfg = state.config || {};
    $('cfgUrl').value = cfg.url || '';
    $('cfgUser').value = cfg.username || '';
    $('cfgPass').value = cfg.password || '';
    $('cfgInterval').value = cfg.interval || 5;
    hideEl('settingsError');
    $('disconnectBtn').classList.toggle('hidden', !state.config);
    $('saveConnBtn').textContent = state.config ? 'Save & reconnect' : 'Connect';
    show('settingsModal');
  }

  async function saveConnection() {
    const cfg = {
      url: $('cfgUrl').value.trim(),
      username: $('cfgUser').value.trim(),
      password: $('cfgPass').value,
      interval: parseInt($('cfgInterval').value, 10) || 5,
    };
    if (!cfg.url) { settingsError('Please enter a server URL.'); return; }

    const btn = $('saveConnBtn');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const client = new CalDAV(cfg);
      await client.test();
      state.config = cfg;
      state.client = client;
      saveConfig(cfg);
      // Reset data and reload.
      state.tasks = {};
      state.collections = [];
      hide('settingsModal');
      await initialLoad();
    } catch (e) {
      settingsError(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = state.config ? 'Save & reconnect' : 'Connect';
    }
  }
  function settingsError(msg) { const e = $('settingsError'); e.textContent = msg; e.classList.remove('hidden'); }

  function disconnect() {
    stopPolling();
    clearConfig();
    state.config = null; state.client = null;
    state.tasks = {}; state.collections = [];
    $('taskList').innerHTML = '';
    $('listNav').innerHTML = '';
    renderTasks();
    hide('settingsModal');
    openSettings();
  }

  // ---- Sidebar toggle --------------------------------------------------
  function toggleSidebar() {
    if (window.innerWidth < 840) {
      document.body.classList.toggle('sidebar-open');
    } else {
      document.body.classList.toggle('sidebar-collapsed');
    }
  }

  // ---- Wire up events --------------------------------------------------
  function bind() {
    $('menuBtn').addEventListener('click', toggleSidebar);
    $('scrim').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
    $('settingsBtn').addEventListener('click', openSettings);
    $('saveConnBtn').addEventListener('click', saveConnection);
    $('disconnectBtn').addEventListener('click', disconnect);

    $('addBtn').addEventListener('click', () => {
      if (!state.client) { openSettings(); return; }
      openForm(null);
    });

    $('toggleCompletedBtn').addEventListener('click', () => {
      state.showCompleted = !state.showCompleted;
      saveUIState();
      renderTasks();
    });

    // Detail actions
    $('editTaskBtn').addEventListener('click', () => {
      if (!detailTask) return;
      hide('detailModal');
      openForm(detailTask);
    });
    $('deleteTaskBtn').addEventListener('click', async () => {
      if (!detailTask) return;
      const ok = await confirmDialog('Delete task?', 'This can’t be undone.', 'Delete');
      if (ok) deleteTask(detailTask);
    });

    // Form
    $('saveTaskBtn').addEventListener('click', saveForm);
    document.querySelectorAll('#fPriority .pri-opt').forEach((el) => {
      el.addEventListener('click', () => setFormPriority(el.dataset.pri));
    });
    $('fRepeatOn').addEventListener('change', () => {
      $('repeatDetails').classList.toggle('hidden', !$('fRepeatOn').checked);
    });
    $('fRepeatEnd').addEventListener('change', syncRepeatVisibility);

    // Close buttons + overlay click
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => hide(el.dataset.close));
    });
    document.querySelectorAll('.modal-overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.add('hidden'); });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => m.classList.add('hidden'));
      }
    });

    // Refresh when the tab becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.client) pollNow();
    });
  }

  // ---- Boot ------------------------------------------------------------
  function boot() {
    bind();
    const ui = loadUIState();
    state.currentList = ui.currentList || ALL;
    state.lastUsedCollection = ui.lastUsedCollection || null;
    state.showCompleted = !!ui.showCompleted;

    // Start with sidebar docked on desktop, collapsed on mobile.
    if (window.innerWidth < 840) document.body.classList.remove('sidebar-open');

    state.config = loadConfig();
    if (state.config) {
      state.client = new CalDAV(state.config);
      initialLoad();
    } else {
      openSettings();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
