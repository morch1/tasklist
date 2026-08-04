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
    selectedLists: [],     // array of collection URLs (all = all collections selected)
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
      selectedLists: state.selectedLists,
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
  function isDueToday(task) {
    if (!task.due) return false;
    const d0 = new Date(task.due); d0.setHours(0, 0, 0, 0);
    return d0.getTime() === startOfToday().getTime();
  }
  // "Urgent" tasks get a red due badge and sort in the top group alongside
  // overdue/flagged tasks: anything overdue, plus all-day tasks due today.
  // (A timed task due today only counts once its time has passed, which
  // isOverdue already covers.)
  function isUrgent(task) {
    if (!task.due || task.completed) return false;
    if (isOverdue(task)) return true;
    if (task.dueDateOnly && isDueToday(task)) return true;
    return false;
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
    trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  };

  // ---- Sorting ---------------------------------------------------------
  // 1. Flagged tasks first, by due date.
  // 2. Unflagged tasks, by due date.
  function sortTasks(list) {
    return list.slice().sort(function (a, b) {
      // Flagged tasks sort before unflagged.
      if (!!a.flagged !== !!b.flagged) return a.flagged ? -1 : 1;

      // Due date ascending; tasks without a due date sort last.
      const at = a.due ? a.due.getTime() : Infinity;
      const bt = b.due ? b.due.getTime() : Infinity;
      if (at !== bt) return at - bt;

      return (a.summary || '').localeCompare(b.summary || '');
    });
  }

  function currentTasks() {
    let list = [];
    state.selectedLists.forEach((url) => { list = list.concat(state.tasks[url] || []); });
    return list;
  }

  // ---- Rendering: sidebar ---------------------------------------------
  // Count active tasks: for a single collection URL or for ALL (all collections).
  function countActive(url) {
    if (url === ALL) {
      let list = [];
      Object.keys(state.tasks).forEach((u) => { list = list.concat(state.tasks[u]); });
      return list.filter((t) => !t.completed).length;
    }
    return (state.tasks[url] || []).filter((t) => !t.completed).length;
  }
  function currentTasksAll() {
    let list = [];
    Object.keys(state.tasks).forEach((url) => { list = list.concat(state.tasks[url]); });
    return list;
  }

  function renderSidebar() {
    const nav = $('listNav');
    nav.innerHTML = '';

    const allSelected = state.collections.length > 0 &&
      state.collections.every((c) => state.selectedLists.indexOf(c.url) >= 0);

    // "All Tasks" item — toggles all lists on/off
    const allBtn = document.createElement('button');
    allBtn.className = 'list-item' + (allSelected ? ' active' : '');
    const allActive = countActive(ALL);
    allBtn.innerHTML =
      '<span class="checkbox"></span>' +
      '<span class="name"></span>' +
      (allActive ? '<span class="count">' + allActive + '</span>' : '');
    allBtn.querySelector('.name').textContent = 'All Tasks';
    allBtn.addEventListener('click', () => {
      if (allSelected) {
        // Deselect all
        state.selectedLists = [];
      } else {
        // Select all
        state.selectedLists = state.collections.map((c) => c.url);
      }
      saveUIState();
      renderSidebar();
      renderTasks();
      updateTitle();
    });
    nav.appendChild(allBtn);

    // Individual list items
    state.collections.forEach((col) => {
      const btn = document.createElement('button');
      const isSelected = state.selectedLists.indexOf(col.url) >= 0;
      btn.className = 'list-item' + (isSelected ? ' active' : '');
      const active = countActive(col.url);
      btn.innerHTML =
        '<span class="checkbox"></span>' +
        '<span class="name"></span>' +
        (active ? '<span class="count">' + active + '</span>' : '');
      btn.querySelector('.name').textContent = col.displayName;
      btn.addEventListener('click', () => {
        const idx = state.selectedLists.indexOf(col.url);
        if (idx >= 0) {
          state.selectedLists.splice(idx, 1);
        } else {
          state.selectedLists.push(col.url);
        }
        saveUIState();
        renderSidebar();
        renderTasks();
        updateTitle();
      });
      nav.appendChild(btn);
    });
  }

  function updateTitle() {
    if (state.selectedLists.length === 0) {
      $('appTitle').textContent = 'Tasks';
    } else if (state.selectedLists.length === 1) {
      const c = state.collections.find((x) => x.url === state.selectedLists[0]);
      $('appTitle').textContent = c ? c.displayName : 'Tasks';
    } else if (state.selectedLists.length === state.collections.length) {
      $('appTitle').textContent = 'All Tasks';
    } else {
      $('appTitle').textContent = state.selectedLists.length + ' lists';
    }
  }

  // ---- Rendering: task list -------------------------------------------
  function makeTaskEl(task) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.completed ? ' done' : '') + (task.flagged ? ' flagged' : '');
    li.dataset.uid = task.uid;
    li.dataset.href = task.href || '';

    // Checkbox
    const check = document.createElement('button');
    check.className = 'check';
    check.innerHTML = SVG.check;
    check.title = task.completed ? 'Mark not done' : 'Mark done';
    check.addEventListener('click', (e) => { e.stopPropagation(); toggleComplete(task, li); });
    li.appendChild(check);

    // Main (title + badges)
    const main = document.createElement('div');
    main.className = 'task-main';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.summary || '(No title)';
    main.appendChild(title);

    if (task.description) {
      const desc = document.createElement('div');
      desc.className = 'task-desc';
      desc.textContent = task.description;
      main.appendChild(desc);
    }

    const badges = document.createElement('div');
    badges.className = 'badges';
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

    // Due date badge on the right side (before flag icon).
    if (task.due) {
      const due = document.createElement('span');
      due.className = 'due-badge' + (isUrgent(task) ? ' overdue' : '');
      due.textContent = formatDueBadge(task);
      due.addEventListener('click', (e) => { e.stopPropagation(); openDetail(task); });
      li.appendChild(due);
    }

    // Flag indicator (hidden for completed tasks).
    if (!task.completed) {
      const pri = document.createElement('button');
      pri.className = 'pri-indicator';
      pri.dataset.flagged = task.flagged ? 'true' : 'false';
      pri.innerHTML = SVG.flag;
      pri.title = task.flagged ? 'Flagged' : 'Not flagged';
      pri.addEventListener('click', (e) => { e.stopPropagation(); toggleFlag(task); });
      li.appendChild(pri);
    }

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
    // Advance the revision counter since this is an update to an existing task.
    ICAL.bumpSequence(task);
    const ics = ICAL.buildTodo(task);
    try {
      setSync('syncing');
      let res;
      try {
        res = await state.client.putTodo(task.href, ics, task.etag);
      } catch (e) {
        // 409/412 means our etag is stale. Refresh it and retry once
        // (last write wins).
        if (e.status !== 409 && e.status !== 412) throw e;
        task.etag = await state.client.getResourceEtag(task.href);
        res = await state.client.putTodo(task.href, ics, task.etag);
      }
      if (res.etag) task.etag = res.etag;
      setSync('ok');
    } catch (e) {
      setSync('error');
      showBanner('Could not save changes: ' + e.message);
      // Re-sync to reconcile.
      pollNow();
    }
  }

  // Toggle the flag between highest priority (1) and none.
  function toggleFlag(task) {
    task.flagged = !task.flagged;
    task.priorityInt = task.flagged ? 1 : 0;
    renderTasks();
    pushTask(task);
  }

  function toggleComplete(task, li) {
    if (task.completed) {
      // Un-completing happens immediately (no animation).
      task.completed = false;
      task.status = 'NEEDS-ACTION';
      task.completedAt = null;
      pushTask(task);
      renderSidebar();
      renderTasks();
      return;
    }

    // Completing: update the model and push to the backend immediately. The
    // delay before the list re-renders is purely cosmetic.
    if (!(task.rrule && task.rrule.FREQ && rollRecurrence(task))) {
      task.completed = true;
      task.status = 'COMPLETED';
      task.completedAt = ICAL.nowStamp();
    }
    // Marking a task done always clears its flag (including recurring tasks,
    // whose next occurrence starts unflagged).
    task.flagged = false;
    task.priorityInt = 0;
    pushTask(task);

    if (li && li.isConnected) animateComplete(li);
    else { renderSidebar(); renderTasks(); }
  }

  // Show the checked task in its "done" state, hold briefly, fade it out, then
  // re-render so it lands in the completed section (or its next recurring
  // occurrence appears) instantly. The item ignores UI input throughout.
  function animateComplete(li) {
    li.classList.add('done', 'completing');
    setTimeout(function () {
      li.classList.add('leaving');
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        li.removeEventListener('transitionend', finish);
        renderSidebar();
        renderTasks();
      };
      li.addEventListener('transitionend', finish);
      setTimeout(finish, 400); // fallback if transitionend doesn't fire
    }, 200);
  }

  // True while a completion animation is in progress (used to defer re-renders
  // that would otherwise yank the animating element out from under the user).
  function isAnimating() {
    return !!document.querySelector('.task-item.completing');
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
    rows.push('<div class="detail-heading' + (task.completed ? ' done' : '') + '">' +
      '<button id="detailCheck" class="check" title="' +
      (task.completed ? 'Mark not done' : 'Mark done') + '">' + SVG.check + '</button>' +
      '<div class="detail-title"></div></div>');

    rows.push(row('Flag',
      '<button id="detailFlagBtn" class="flag-toggle" data-flagged="' + (task.flagged ? 'true' : 'false') + '">' +
      SVG.flag + '<span class="flag-label">' + (task.flagged ? 'Flagged' : 'Not flagged') + '</span></button>', true));

    if (task.due) {
      rows.push(row('Due', '<span class="value ' + (isUrgent(task) ? 'overdue' : '') + '">' +
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
    const dc = $('detailCheck');
    if (dc) dc.addEventListener('click', () => { toggleComplete(task); openDetail(task); });
    const fb = $('detailFlagBtn');
    if (fb) fb.addEventListener('click', () => { toggleFlag(task); openDetail(task); });
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
  let formFlagged = false;
  let formReminders = []; // managed reminder models or preserved custom alarms
  let formDueDateWasSet = false;

  function setFormFlag(flagged) {
    formFlagged = !!flagged;
    const btn = $('fFlag');
    btn.dataset.flagged = formFlagged ? 'true' : 'false';
    btn.querySelector('.flag-label').textContent = formFlagged ? 'Flagged' : 'Not flagged';
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
      setFormFlag(task.flagged);
      loadDueForm(task);
      loadReminderForm(task);
      $('fDesc').value = task.description || '';
      sel.value = task._collectionURL;
      loadRepeatForm(task.rrule);
    } else {
      $('fTitle').value = '';
      setFormFlag(false);
      loadDueForm(null);
      loadReminderForm(null);
      $('fDesc').value = '';
      // Default to the first selected list; if none selected, the last-used list.
      const preferred = (state.selectedLists[0] || state.lastUsedCollection);
      sel.value = preferred || (state.collections[0] && state.collections[0].url);
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

  function loadReminderForm(task) {
    formReminders = (task && task.alarms ? task.alarms : []).map(function (lines) {
      const parsed = ICAL.parseReminder(lines);
      if (!parsed) {
        return { type: 'custom', alarmLines: lines.slice() };
      }
      if (parsed.type === 'absolute') {
        return {
          type: 'absolute',
          date: toDateInput(parsed.date),
          includeTime: !parsed.dateOnly,
          time: parsed.dateOnly ? '09:00' : toTimeInput(parsed.date),
        };
      }
      if (parsed.type === 'before') {
        return {
          type: 'before',
          amount: String(parsed.amount),
          unit: parsed.unit,
        };
      }
      return { type: 'due' };
    });
    renderReminderForm();
  }

  function makeReminderOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  function changeReminderType(index, type) {
    if (type === 'before') {
      formReminders[index] = { type: 'before', amount: '10', unit: 'minutes' };
    } else if (type === 'absolute') {
      formReminders[index] = {
        type: 'absolute',
        date: $('fDue').value || toDateInput(new Date()),
        includeTime: false,
        time: '09:00',
      };
    } else {
      formReminders[index] = { type: 'due' };
    }
    renderReminderForm();
  }

  function makeReminderDeleteButton(index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn reminder-delete';
    button.title = 'Delete reminder';
    button.setAttribute('aria-label', 'Delete reminder ' + (index + 1));
    button.innerHTML = SVG.trash;
    button.addEventListener('click', function () {
      formReminders.splice(index, 1);
      renderReminderForm();
    });
    return button;
  }

  function renderReminderForm() {
    const list = $('reminderList');
    list.innerHTML = '';

    if (!formReminders.length) {
      const empty = document.createElement('p');
      empty.className = 'reminder-empty';
      empty.textContent = 'No reminders';
      list.appendChild(empty);
      return;
    }

    formReminders.forEach(function (reminder, index) {
      const item = document.createElement('div');
      item.className = 'reminder-item';
      const main = document.createElement('div');
      main.className = 'reminder-main';

      if (reminder.type === 'custom') {
        const label = document.createElement('span');
        label.className = 'reminder-custom';
        label.textContent = 'Custom reminder (kept as-is)';
        main.appendChild(label);
      } else {
        const type = document.createElement('select');
        type.className = 'reminder-type';
        type.setAttribute('aria-label', 'Reminder ' + (index + 1) + ' type');
        type.appendChild(makeReminderOption('due', 'At due date'));
        type.appendChild(makeReminderOption('before', 'Before due date'));
        type.appendChild(makeReminderOption('absolute', 'At specific date'));
        type.value = reminder.type;
        type.addEventListener('change', function () {
          changeReminderType(index, type.value);
        });
        main.appendChild(type);
      }
      main.appendChild(makeReminderDeleteButton(index));
      item.appendChild(main);

      if (reminder.type === 'before') {
        const options = document.createElement('div');
        options.className = 'reminder-options';
        const amount = document.createElement('input');
        amount.type = 'number';
        amount.min = '1';
        amount.step = '1';
        amount.value = reminder.amount;
        amount.setAttribute('aria-label', 'Time before due date');
        amount.addEventListener('input', function () { reminder.amount = amount.value; });
        options.appendChild(amount);

        const unit = document.createElement('select');
        unit.setAttribute('aria-label', 'Reminder time unit');
        ['minutes', 'hours', 'days', 'weeks'].forEach(function (value) {
          unit.appendChild(makeReminderOption(value, value));
        });
        unit.value = reminder.unit;
        unit.addEventListener('change', function () { reminder.unit = unit.value; });
        options.appendChild(unit);

        const suffix = document.createElement('span');
        suffix.textContent = 'before due date';
        options.appendChild(suffix);
        item.appendChild(options);
      } else if (reminder.type === 'absolute') {
        const options = document.createElement('div');
        options.className = 'reminder-options';
        const date = document.createElement('input');
        date.type = 'date';
        date.value = reminder.date || '';
        date.setAttribute('aria-label', 'Reminder date');
        date.addEventListener('input', function () { reminder.date = date.value; });
        options.appendChild(date);

        const timeToggle = document.createElement('label');
        timeToggle.className = 'reminder-time-toggle';
        const includeTime = document.createElement('input');
        includeTime.type = 'checkbox';
        includeTime.checked = !!reminder.includeTime;
        includeTime.addEventListener('change', function () {
          reminder.includeTime = includeTime.checked;
          if (reminder.includeTime && !reminder.time) reminder.time = '09:00';
          renderReminderForm();
        });
        timeToggle.appendChild(includeTime);
        timeToggle.appendChild(document.createTextNode('Include time'));
        options.appendChild(timeToggle);

        if (reminder.includeTime) {
          const time = document.createElement('input');
          time.type = 'time';
          time.value = reminder.time || '';
          time.setAttribute('aria-label', 'Reminder time');
          time.addEventListener('input', function () { reminder.time = time.value; });
          options.appendChild(time);
        }
        item.appendChild(options);
      }

      list.appendChild(item);
    });
  }

  function hasDueDateReminder() {
    return formReminders.some(function (reminder) {
      return reminder.type === 'due' ||
        (reminder.type === 'custom' && ICAL.isDueReminder(reminder.alarmLines));
    });
  }

  // Add the default at-due reminder only when a task gets its first due date.
  // Once the form started with or has been given a due date, subsequent date
  // changes must not recreate a reminder the user chose to remove.
  function handleDueDateSet() {
    if (!$('fDue').value || formDueDateWasSet) return;
    formDueDateWasSet = true;
    if (!hasDueDateReminder()) {
      formReminders.push({ type: 'due' });
      renderReminderForm();
    }
  }

  function addReminder() {
    if ($('fDue').value) {
      formReminders.push({ type: 'due' });
    } else {
      formReminders.push({
        type: 'absolute',
        date: toDateInput(new Date()),
        includeTime: false,
        time: '09:00',
      });
    }
    renderReminderForm();
  }

  function buildReminderAlarms(title, hasDue) {
    return formReminders.map(function (reminder, index) {
      const prefix = 'Reminder ' + (index + 1) + ': ';
      if (reminder.type === 'custom') return reminder.alarmLines.slice();

      if ((reminder.type === 'due' || reminder.type === 'before') && !hasDue) {
        throw new Error(prefix + 'add a due date to use a due-date reminder.');
      }

      let model;
      if (reminder.type === 'before') {
        const amountText = String(reminder.amount || '').trim();
        const amount = Number(amountText);
        if (!/^\d+$/.test(amountText) || !Number.isSafeInteger(amount) || amount < 1) {
          throw new Error(prefix + 'the amount must be a whole number of at least 1.');
        }
        if (['minutes', 'hours', 'days', 'weeks'].indexOf(reminder.unit) < 0) {
          throw new Error(prefix + 'choose a valid time unit.');
        }
        model = { type: 'before', amount: amount, unit: reminder.unit };
      } else if (reminder.type === 'absolute') {
        if (!reminder.date) throw new Error(prefix + 'choose a date.');
        if (reminder.includeTime && !reminder.time) {
          throw new Error(prefix + 'choose a time or turn off Include time.');
        }
        const date = reminder.includeTime
          ? fromDateTimeInput(reminder.date, reminder.time)
          : fromDateInput(reminder.date);
        if (isNaN(date.getTime())) throw new Error(prefix + 'choose a valid date.');
        model = { type: 'absolute', date: date, dateOnly: !reminder.includeTime };
      } else {
        model = { type: 'due' };
      }
      return ICAL.buildReminder(model, title);
    });
  }

  async function saveForm() {
    const title = $('fTitle').value.trim();
    if (!title) { showFormError('Please enter a title.'); return; }
    const colURL = $('fList').value;
    if (!colURL) { showFormError('Please choose a task list.'); return; }

    const dueVal = $('fDue').value;
    let due = null, dueDateOnly = true;
    if (dueVal) {
      if ($('fAllDay').checked) {
        due = fromDateInput(dueVal);
        dueDateOnly = true;
      } else {
        due = fromDateTimeInput(dueVal, $('fDueTime').value);
        dueDateOnly = false;
      }
    }
    const rrule = buildRRuleFromForm();
    let reminderAlarms;
    try {
      reminderAlarms = buildReminderAlarms(title, !!due);
    } catch (e) {
      showFormError(e.message);
      return;
    }

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
    task.flagged = formFlagged;
    task.priorityInt = formFlagged ? (task.priorityInt > 0 ? task.priorityInt : 1) : 0;
    task.due = due;
    task.dueDateOnly = due ? dueDateOnly : false;
    task.description = $('fDesc').value.trim();
    task.rrule = rrule;
    task.alarms = reminderAlarms;

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
        const res = await state.client.putTodo(task.href, ICAL.buildTodo(task), null, true);
        if (res.etag) task.etag = res.etag;
        (state.tasks[colURL] = state.tasks[colURL] || []).push(task);
      } else if (movingList) {
        // Moved to a different list: create in new, delete from old.
        const oldHref = task.href, oldEtag = task.etag, oldURL = task._collectionURL;
        task._collectionURL = colURL;
        task._collectionName = collectionName(colURL);
        task.href = colURL.replace(/\/?$/, '/') + task.uid + '.ics';
        task.etag = null;
        // Moving lists is still an update to the task; advance its revision.
        ICAL.bumpSequence(task);
        const res = await state.client.putTodo(task.href, ICAL.buildTodo(task), null, true);
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

  // Delete every completed task in the current view (after confirmation).
  async function deleteAllCompleted() {
    const completed = currentTasks().filter((t) => t.completed);
    if (!completed.length) return;
    const ok = await confirmDialog('Delete all completed?',
      'This will permanently delete ' + completed.length + ' completed task' +
      (completed.length === 1 ? '' : 's') + '.', 'Delete all');
    if (!ok) return;

    setSync('syncing');
    let failed = 0;
    for (const task of completed) {
      try {
        await state.client.deleteTodo(task.href, task.etag);
        state.tasks[task._collectionURL] = (state.tasks[task._collectionURL] || []).filter((t) => t.uid !== task.uid);
      } catch (e) {
        failed++;
      }
    }
    setSync(failed ? 'error' : 'ok');
    if (failed) showBanner('Could not delete ' + failed + ' completed task' + (failed === 1 ? '' : 's') + '.');
    renderTasks();
    renderSidebar();
  }

  // ---- Date input helpers ---------------------------------------------
  function toDateInput(date) {
    const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }
  function toTimeInput(date) {
    const h = date.getHours(), mi = date.getMinutes();
    return (h < 10 ? '0' + h : h) + ':' + (mi < 10 ? '0' + mi : mi);
  }
  function fromDateInput(val) {
    const [y, m, d] = val.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function fromDateTimeInput(dateVal, timeVal) {
    const [y, m, d] = dateVal.split('-').map(Number);
    const [h, mi] = (timeVal || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, h || 0, mi || 0);
  }

  // Populate the due-date/time controls from a task.
  function loadDueForm(task) {
    formDueDateWasSet = !!(task && task.due);
    if (task && task.due) {
      $('fDue').value = toDateInput(task.due);
      if (task.dueDateOnly) {
        $('fAllDay').checked = true;
        $('fDueTime').value = '';
      } else {
        $('fAllDay').checked = false;
        $('fDueTime').value = toTimeInput(task.due);
      }
    } else {
      $('fDue').value = '';
      $('fAllDay').checked = true;
      $('fDueTime').value = '';
    }
    syncDueTimeVisibility();
  }
  function syncDueTimeVisibility() {
    const allDay = $('fAllDay').checked;
    $('fDueTime').classList.toggle('hidden', allDay);
    // When switching to a specific time with none set, default to 09:00.
    if (!allDay && !$('fDueTime').value) $('fDueTime').value = '09:00';
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

      // Restore selected lists, filtering out any stale collection URLs.
      const validUrls = state.collections.map((c) => c.url);
      state.selectedLists = state.selectedLists.filter((url) => validUrls.indexOf(url) >= 0);
      // If nothing is selected, default to all lists.
      if (state.selectedLists.length === 0) {
        state.selectedLists = validUrls.slice();
      }
      if (!state.lastUsedCollection || validUrls.indexOf(state.lastUsedCollection) < 0) {
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
      if (changed && !isAnimating()) {
        // Preserve open modals; just refresh the visible list. If a completion
        // animation is running, its own finish handler will render the update.
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
    b.classList.toggle('info', isError === false);
    b.classList.remove('hidden');
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

    $('deleteAllCompletedBtn').addEventListener('click', deleteAllCompleted);

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
    $('addReminderBtn').addEventListener('click', addReminder);
    $('fFlag').addEventListener('click', () => setFormFlag(!formFlagged));
    $('fDue').addEventListener('change', handleDueDateSet);
    $('fAllDay').addEventListener('change', syncDueTimeVisibility);
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
    // Restore selected lists from saved state. Backward compat: if the old
    // single-selection key exists, migrate it to the new array format.
    if (Array.isArray(ui.selectedLists) && ui.selectedLists.length > 0) {
      state.selectedLists = ui.selectedLists;
    } else if (ui.currentList) {
      state.selectedLists = ui.currentList === ALL ? [] : [ui.currentList];
    } else {
      state.selectedLists = [];
    }
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
