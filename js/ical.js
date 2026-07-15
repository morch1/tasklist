/*
 * ical.js - Minimal iCalendar (RFC 5545) parser/serializer focused on VTODO.
 * Exposes a global `ICAL` object. No external dependencies.
 */
(function (global) {
  'use strict';

  // ---- Priority mapping ------------------------------------------------
  // App priority levels <-> iCalendar PRIORITY integer (RFC 5545).
  //   none   -> undefined (omitted / 0)
  //   high   -> 1
  //   medium -> 5
  //   low    -> 9
  const PRIORITY = { NONE: 'none', LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };

  function priorityFromInt(n) {
    if (n === undefined || n === null || n === 0 || isNaN(n)) return PRIORITY.NONE;
    if (n >= 1 && n <= 4) return PRIORITY.HIGH;
    if (n === 5) return PRIORITY.MEDIUM;
    if (n >= 6 && n <= 9) return PRIORITY.LOW;
    return PRIORITY.NONE;
  }

  function priorityToInt(p) {
    switch (p) {
      case PRIORITY.HIGH: return 1;
      case PRIORITY.MEDIUM: return 5;
      case PRIORITY.LOW: return 9;
      default: return 0;
    }
  }

  // Sort rank: higher number sorts first.
  function priorityRank(p) {
    switch (p) {
      case PRIORITY.HIGH: return 3;
      case PRIORITY.MEDIUM: return 2;
      case PRIORITY.LOW: return 1;
      default: return 0;
    }
  }

  // ---- Line unfolding / folding ---------------------------------------
  function unfold(text) {
    // RFC 5545: a CRLF followed by whitespace is a continuation.
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  }

  function fold(line) {
    // Fold to 75 octets. Approximate on characters (good enough for text).
    const chunks = [];
    let s = line;
    const max = 74;
    while (s.length > max) {
      chunks.push(s.slice(0, max));
      s = ' ' + s.slice(max);
    }
    chunks.push(s);
    return chunks.join('\r\n');
  }

  // ---- Value escaping --------------------------------------------------
  function escapeText(v) {
    return String(v)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  function unescapeText(v) {
    return String(v)
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  // ---- Property line parsing ------------------------------------------
  // Parse "NAME;PARAM=VAL;PARAM2=VAL2:VALUE" into {name, params, value}
  function parseLine(line) {
    // Find the first unquoted colon.
    let inQuote = false;
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === ':' && !inQuote) { colon = i; break; }
    }
    if (colon === -1) return null;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);

    // Split head by unquoted semicolons.
    const parts = [];
    let cur = '';
    inQuote = false;
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (c === '"') { inQuote = !inQuote; cur += c; }
      else if (c === ';' && !inQuote) { parts.push(cur); cur = ''; }
      else cur += c;
    }
    parts.push(cur);

    const name = parts[0].toUpperCase();
    const params = {};
    for (let i = 1; i < parts.length; i++) {
      const eq = parts[i].indexOf('=');
      if (eq === -1) continue;
      const pn = parts[i].slice(0, eq).toUpperCase();
      let pv = parts[i].slice(eq + 1);
      if (pv.startsWith('"') && pv.endsWith('"')) pv = pv.slice(1, -1);
      params[pn] = pv;
    }
    return { name, params, value };
  }

  // ---- Date/time handling ---------------------------------------------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // Parse iCal date/datetime -> { date: Date, dateOnly: bool }
  function parseDate(value, params) {
    const dateOnly = (params && params.VALUE === 'DATE') || /^\d{8}$/.test(value);
    if (dateOnly) {
      const y = +value.slice(0, 4), m = +value.slice(4, 6) - 1, d = +value.slice(6, 8);
      return { date: new Date(y, m, d), dateOnly: true };
    }
    const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (!m) {
      const dt = new Date(value);
      return { date: isNaN(dt) ? null : dt, dateOnly: false };
    }
    const [, y, mo, d, h, mi, s, z] = m;
    let dt;
    if (z) dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    else dt = new Date(+y, +mo - 1, +d, +h, +mi, +s); // floating/local
    return { date: dt, dateOnly: false };
  }

  function formatDate(date, dateOnly) {
    if (dateOnly) {
      return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
    }
    // Serialize as UTC.
    return date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) +
      'T' + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z';
  }

  function nowStamp() {
    return formatDate(new Date(), false);
  }

  // ---- RRULE parse / build --------------------------------------------
  function parseRRule(value) {
    const rule = {};
    value.split(';').forEach(function (part) {
      const eq = part.indexOf('=');
      if (eq === -1) return;
      const k = part.slice(0, eq).toUpperCase();
      const v = part.slice(eq + 1);
      rule[k] = v;
    });
    return rule;
  }

  function buildRRule(rule) {
    const order = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST'];
    const parts = [];
    order.forEach(function (k) {
      if (rule[k] !== undefined && rule[k] !== null && rule[k] !== '') {
        parts.push(k + '=' + rule[k]);
      }
    });
    // Include any other keys not in the ordered list.
    Object.keys(rule).forEach(function (k) {
      if (order.indexOf(k) === -1 && rule[k] !== undefined && rule[k] !== '') {
        parts.push(k + '=' + rule[k]);
      }
    });
    return parts.join(';');
  }

  // Advance a date by one recurrence interval.
  function advanceDate(date, rule) {
    const interval = parseInt(rule.INTERVAL, 10) || 1;
    const d = new Date(date.getTime());
    switch ((rule.FREQ || '').toUpperCase()) {
      case 'DAILY': d.setDate(d.getDate() + interval); break;
      case 'WEEKLY': d.setDate(d.getDate() + 7 * interval); break;
      case 'MONTHLY': d.setMonth(d.getMonth() + interval); break;
      case 'YEARLY': d.setFullYear(d.getFullYear() + interval); break;
      default: return null;
    }
    return d;
  }

  // ---- VTODO parsing ---------------------------------------------------
  // Parse a full calendar object (may contain a VTODO) into a task object.
  function parseTodo(icsText) {
    const lines = unfold(icsText).split(/\r\n|\n|\r/);
    let inTodo = false;
    const props = {};
    let uid = null;

    for (const raw of lines) {
      if (!raw) continue;
      const upper = raw.toUpperCase();
      if (upper.startsWith('BEGIN:VTODO')) { inTodo = true; continue; }
      if (upper.startsWith('END:VTODO')) { inTodo = false; continue; }
      if (!inTodo) continue;
      const p = parseLine(raw);
      if (!p) continue;
      // Store multi-valued props as-is; keep first occurrence for singletons.
      props[p.name] = p;
      if (p.name === 'UID') uid = p.value;
    }

    if (!uid && Object.keys(props).length === 0) return null;

    const task = {
      uid: uid,
      summary: props.SUMMARY ? unescapeText(props.SUMMARY.value) : '',
      description: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : '',
      priority: props.PRIORITY ? priorityFromInt(parseInt(props.PRIORITY.value, 10)) : PRIORITY.NONE,
      status: props.STATUS ? props.STATUS.value.toUpperCase() : 'NEEDS-ACTION',
      completed: props.STATUS && props.STATUS.value.toUpperCase() === 'COMPLETED',
      due: null,
      dueDateOnly: false,
      dtstart: null,
      rrule: props.RRULE ? parseRRule(props.RRULE.value) : null,
      created: props.CREATED ? props.CREATED.value : null,
      lastModified: props['LAST-MODIFIED'] ? props['LAST-MODIFIED'].value : null,
      // Preserve unknown props so we don't lose data on round-trip.
      _extra: {},
    };

    if (props.DUE) {
      const d = parseDate(props.DUE.value, props.DUE.params);
      task.due = d.date;
      task.dueDateOnly = d.dateOnly;
    }
    if (props.DTSTART) {
      const d = parseDate(props.DTSTART.value, props.DTSTART.params);
      task.dtstart = d.date;
      task.dtstartDateOnly = d.dateOnly;
    }

    // Preserve properties we don't explicitly model.
    const known = new Set(['UID', 'SUMMARY', 'DESCRIPTION', 'PRIORITY', 'STATUS',
      'DUE', 'DTSTART', 'RRULE', 'CREATED', 'LAST-MODIFIED', 'DTSTAMP',
      'COMPLETED', 'PERCENT-COMPLETE', 'SEQUENCE']);
    Object.keys(props).forEach(function (k) {
      if (!known.has(k)) task._extra[k] = props[k];
    });

    return task;
  }

  // ---- VTODO serialization --------------------------------------------
  function buildTodo(task) {
    const lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//tasklist//caldav//EN');
    lines.push('BEGIN:VTODO');
    lines.push('UID:' + task.uid);
    lines.push('DTSTAMP:' + nowStamp());
    if (task.created) lines.push('CREATED:' + task.created);
    lines.push('LAST-MODIFIED:' + nowStamp());
    lines.push('SUMMARY:' + escapeText(task.summary || ''));
    if (task.description) lines.push('DESCRIPTION:' + escapeText(task.description));

    const pInt = priorityToInt(task.priority);
    if (pInt) lines.push('PRIORITY:' + pInt);

    if (task.due) {
      if (task.dueDateOnly) lines.push('DUE;VALUE=DATE:' + formatDate(task.due, true));
      else lines.push('DUE:' + formatDate(task.due, false));
    }
    if (task.dtstart) {
      if (task.dtstartDateOnly) lines.push('DTSTART;VALUE=DATE:' + formatDate(task.dtstart, true));
      else lines.push('DTSTART:' + formatDate(task.dtstart, false));
    }
    if (task.rrule && task.rrule.FREQ) {
      lines.push('RRULE:' + buildRRule(task.rrule));
    }

    if (task.completed) {
      lines.push('STATUS:COMPLETED');
      lines.push('PERCENT-COMPLETE:100');
      lines.push('COMPLETED:' + (task.completedAt || nowStamp()));
    } else {
      lines.push('STATUS:NEEDS-ACTION');
    }

    // Re-emit preserved extra properties.
    if (task._extra) {
      Object.keys(task._extra).forEach(function (k) {
        const p = task._extra[k];
        let head = p.name;
        Object.keys(p.params || {}).forEach(function (pn) {
          head += ';' + pn + '=' + p.params[pn];
        });
        lines.push(head + ':' + p.value);
      });
    }

    lines.push('END:VTODO');
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function generateUID() {
    const rnd = () => Math.random().toString(36).slice(2, 10);
    return rnd() + '-' + rnd() + '-' + Date.now().toString(36) + '@tasklist';
  }

  global.ICAL = {
    PRIORITY: PRIORITY,
    priorityFromInt: priorityFromInt,
    priorityToInt: priorityToInt,
    priorityRank: priorityRank,
    parseTodo: parseTodo,
    buildTodo: buildTodo,
    parseDate: parseDate,
    formatDate: formatDate,
    parseRRule: parseRRule,
    buildRRule: buildRRule,
    advanceDate: advanceDate,
    generateUID: generateUID,
    nowStamp: nowStamp,
  };
})(typeof window !== 'undefined' ? window : this);
