/*
 * ical.js - Minimal iCalendar (RFC 5545) parser/serializer focused on VTODO.
 * Exposes a global `ICAL` object. No external dependencies.
 */
(function (global) {
  'use strict';

  // ---- Priority / flag -------------------------------------------------
  // The app models priority as a single "flagged" boolean. A task is flagged
  // if the iCalendar PRIORITY property is set to anything other than 0. The
  // original integer is preserved so round-tripping a task flagged elsewhere
  // (e.g. PRIORITY:5) doesn't clobber its value. Toggling the flag on writes
  // the highest priority (1); toggling it off removes the property.

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
  // Nested components (VALARM etc.) are captured as raw line blocks so their
  // properties never mix with the VTODO's own (e.g. a VALARM DESCRIPTION must
  // not surface as the task description) and survive round-trips verbatim.
  function parseTodo(icsText) {
    const lines = unfold(icsText).split(/\r\n|\n|\r/);
    let inTodo = false;
    const props = {};
    let uid = null;
    const alarms = [];      // arrays of raw VALARM property lines
    const otherComps = [];  // { name, lines } for any other nested component
    let nested = null;      // { name, lines, depth } while inside one

    for (const raw of lines) {
      if (!raw) continue;
      const upper = raw.toUpperCase();
      if (!inTodo) {
        if (upper.startsWith('BEGIN:VTODO')) inTodo = true;
        continue;
      }
      if (nested) {
        if (upper.startsWith('BEGIN:')) {
          nested.depth++;
        } else if (upper.startsWith('END:')) {
          if (nested.depth === 0) {
            if (nested.name === 'VALARM') alarms.push(nested.lines);
            else otherComps.push({ name: nested.name, lines: nested.lines });
            nested = null;
            continue;
          }
          nested.depth--;
        }
        nested.lines.push(raw);
        continue;
      }
      if (upper.startsWith('END:VTODO')) { inTodo = false; continue; }
      if (upper.startsWith('BEGIN:')) {
        nested = { name: upper.slice(6).trim(), lines: [], depth: 0 };
        continue;
      }
      const p = parseLine(raw);
      if (!p) continue;
      props[p.name] = p;
      if (p.name === 'UID') uid = p.value;
    }

    if (!uid && Object.keys(props).length === 0) return null;

    const task = {
      uid: uid,
      summary: props.SUMMARY ? unescapeText(props.SUMMARY.value) : '',
      description: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : '',
      priorityInt: props.PRIORITY ? (parseInt(props.PRIORITY.value, 10) || 0) : 0,
      flagged: props.PRIORITY ? (parseInt(props.PRIORITY.value, 10) || 0) > 0 : false,
      status: props.STATUS ? props.STATUS.value.toUpperCase() : 'NEEDS-ACTION',
      completed: props.STATUS && props.STATUS.value.toUpperCase() === 'COMPLETED',
      due: null,
      dueDateOnly: false,
      dtstart: null,
      rrule: props.RRULE ? parseRRule(props.RRULE.value) : null,
      created: props.CREATED ? props.CREATED.value : null,
      lastModified: props['LAST-MODIFIED'] ? props['LAST-MODIFIED'].value : null,
      // Revision counter: integer when present on the server, null when absent.
      sequence: props.SEQUENCE ? (parseInt(props.SEQUENCE.value, 10) || 0) : null,
      alarms: alarms,
      // Preserve unknown props / components so we don't lose data on round-trip.
      _components: otherComps,
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
    if (task.sequence !== null && task.sequence !== undefined) {
      lines.push('SEQUENCE:' + task.sequence);
    }
    lines.push('SUMMARY:' + escapeText(task.summary || ''));
    if (task.description) lines.push('DESCRIPTION:' + escapeText(task.description));

    if (task.flagged) lines.push('PRIORITY:' + (task.priorityInt > 0 ? task.priorityInt : 1));

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

    // Re-emit nested components (properties must precede components).
    (task.alarms || []).forEach(function (alarmLines) {
      lines.push('BEGIN:VALARM');
      alarmLines.forEach(function (l) { lines.push(l); });
      lines.push('END:VALARM');
    });
    (task._components || []).forEach(function (c) {
      lines.push('BEGIN:' + c.name);
      c.lines.forEach(function (l) { lines.push(l); });
      lines.push('END:' + c.name);
    });

    lines.push('END:VTODO');
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function generateUID() {
    const rnd = () => Math.random().toString(36).slice(2, 10);
    return rnd() + '-' + rnd() + '-' + Date.now().toString(36) + '@tasklist';
  }

  // Bump the revision counter for an update: increment an existing SEQUENCE by
  // one, or set it to 1 when the task has none. Apps use SEQUENCE to tell which
  // version of a task is newest, so it must advance on every update.
  function bumpSequence(task) {
    if (task.sequence === null || task.sequence === undefined) {
      task.sequence = 1;
    } else {
      task.sequence = (parseInt(task.sequence, 10) || 0) + 1;
    }
    return task.sequence;
  }

  // ---- Reminder alarms --------------------------------------------------
  // Reminders are persisted as DISPLAY VALARMs. The task form supports
  // alarms at/before DUE and absolute date/time alarms. Keep unrecognised
  // VALARMs as raw lines so alarms created by other clients are not damaged.

  function parseReminder(alarmLines) {
    if (!Array.isArray(alarmLines)) return null;

    const props = {};
    const supported = new Set(['ACTION', 'TRIGGER', 'DESCRIPTION',
      'X-TASKLIST-DATE-ONLY']);
    for (const line of alarmLines) {
      const p = parseLine(line);
      if (!p || !supported.has(p.name) || props[p.name]) return null;
      // Rebuilding parameterised ACTION/DESCRIPTION or extension properties
      // could lose information that is not represented by the form.
      if (p.name !== 'TRIGGER' && Object.keys(p.params).length) return null;
      props[p.name] = p;
    }

    if (!props.ACTION || props.ACTION.value.toUpperCase() !== 'DISPLAY' ||
        !props.TRIGGER) return null;

    const trigger = props.TRIGGER;
    const paramNames = Object.keys(trigger.params);
    if (paramNames.some(function (name) {
      return name !== 'RELATED' && name !== 'VALUE';
    })) return null;

    const related = String(trigger.params.RELATED || '').toUpperCase();
    const valueType = String(trigger.params.VALUE || '').toUpperCase();
    const value = trigger.value.toUpperCase();
    const dateOnlyProp = props['X-TASKLIST-DATE-ONLY'];

    if (related === 'END' && (!valueType || valueType === 'DURATION')) {
      if (dateOnlyProp) return null;
      if (value === 'PT0S') return { type: 'due' };

      const patterns = [
        { re: /^-PT(\d+)M$/, unit: 'minutes' },
        { re: /^-PT(\d+)H$/, unit: 'hours' },
        { re: /^-P(\d+)D$/, unit: 'days' },
        { re: /^-P(\d+)W$/, unit: 'weeks' },
      ];
      for (const pattern of patterns) {
        const match = value.match(pattern.re);
        const amount = match ? Number(match[1]) : 0;
        if (Number.isSafeInteger(amount) && amount > 0) {
          return { type: 'before', amount: amount, unit: pattern.unit };
        }
      }
      return null;
    }

    // RFC 5545 absolute TRIGGER values must be UTC DATE-TIME values. Seconds
    // other than zero cannot be represented by the minute-precision form.
    if (!related && valueType === 'DATE-TIME' &&
        /^\d{8}T\d{6}Z$/.test(value)) {
      const parsed = parseDate(value, trigger.params);
      if (!parsed.date || parsed.date.getSeconds() !== 0) return null;
      const dateOnly = !!dateOnlyProp &&
        dateOnlyProp.value.toUpperCase() === 'TRUE';
      if (dateOnlyProp && !dateOnly) return null;
      return { type: 'absolute', date: parsed.date, dateOnly: dateOnly };
    }

    return null;
  }

  function buildReminder(reminder, summary) {
    if (!reminder) throw new Error('Invalid reminder.');

    let trigger;
    if (reminder.type === 'due') {
      trigger = 'TRIGGER;RELATED=END:PT0S';
    } else if (reminder.type === 'before') {
      const amount = Number(reminder.amount);
      if (!Number.isSafeInteger(amount) || amount < 1) {
        throw new Error('Reminder amount must be a positive integer.');
      }
      const duration = {
        minutes: '-PT' + amount + 'M',
        hours: '-PT' + amount + 'H',
        days: '-P' + amount + 'D',
        weeks: '-P' + amount + 'W',
      }[reminder.unit];
      if (!duration) throw new Error('Invalid reminder unit.');
      trigger = 'TRIGGER;RELATED=END:' + duration;
    } else if (reminder.type === 'absolute') {
      if (!(reminder.date instanceof Date) || isNaN(reminder.date.getTime())) {
        throw new Error('Invalid reminder date.');
      }
      trigger = 'TRIGGER;VALUE=DATE-TIME:' + formatDate(reminder.date, false);
    } else {
      throw new Error('Invalid reminder type.');
    }

    const lines = ['ACTION:DISPLAY', trigger];
    // TRIGGER does not have a DATE value, so retain the user's date-only UI
    // choice with an RFC-compatible extension while firing at local midnight.
    if (reminder.type === 'absolute' && reminder.dateOnly) {
      lines.push('X-TASKLIST-DATE-ONLY:TRUE');
    }
    lines.push('DESCRIPTION:' + escapeText(summary || ''));
    return lines;
  }

  // Legacy helper retained for callers that want to manage a single implicit
  // due-date alarm. The task form now manages its complete alarm list itself.
  function isDueAlarm(alarmLines) {
    return alarmLines.some(function (l) {
      const p = parseLine(l);
      return !!p && p.name === 'TRIGGER' &&
        String(p.params.RELATED || '').toUpperCase() === 'END' &&
        p.value.toUpperCase() === 'PT0S';
    });
  }

  // Ensure the managed alarm exists (and its DESCRIPTION tracks the title)
  // when the task has a due date; remove it when the due date is cleared.
  // Other alarms are left untouched.
  function syncDueAlarm(task) {
    const alarms = (task.alarms || []).slice();
    const idx = alarms.findIndex(isDueAlarm);
    if (task.due) {
      const desc = 'DESCRIPTION:' + escapeText(task.summary || '');
      if (idx === -1) {
        alarms.push(['ACTION:DISPLAY', 'TRIGGER;RELATED=END:PT0S', desc]);
      } else {
        let replaced = false;
        alarms[idx] = alarms[idx].map(function (l) {
          const p = parseLine(l);
          if (p && p.name === 'DESCRIPTION') { replaced = true; return desc; }
          return l;
        });
        if (!replaced) alarms[idx].push(desc);
      }
    } else if (idx !== -1) {
      alarms.splice(idx, 1);
    }
    task.alarms = alarms;
  }

  global.ICAL = {
    parseTodo: parseTodo,
    buildTodo: buildTodo,
    parseDate: parseDate,
    formatDate: formatDate,
    parseRRule: parseRRule,
    buildRRule: buildRRule,
    advanceDate: advanceDate,
    generateUID: generateUID,
    nowStamp: nowStamp,
    parseReminder: parseReminder,
    buildReminder: buildReminder,
    syncDueAlarm: syncDueAlarm,
    bumpSequence: bumpSequence,
  };
})(typeof window !== 'undefined' ? window : this);
