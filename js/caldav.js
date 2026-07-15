/*
 * caldav.js - Minimal CalDAV client for VTODO collections.
 * Exposes a global `CalDAV` class. Uses fetch + Basic auth.
 *
 * NOTE ON CORS: browsers enforce the same-origin policy on fetch(). The CalDAV
 * server must return permissive CORS headers (Access-Control-Allow-Origin,
 * -Methods including PROPFIND/REPORT/PUT/DELETE, -Headers including Authorization,
 * Depth, Content-Type) for this to work directly from the browser. Radicale,
 * Nextcloud, Baikal, etc. can be configured for this, or a reverse proxy can add
 * the headers. This is a limitation of the "entirely client-side" requirement,
 * not of this code.
 */
(function (global) {
  'use strict';

  function joinURL(base, rel) {
    if (!rel) return base;
    if (/^https?:\/\//i.test(rel)) return rel;
    try {
      return new URL(rel, base).href;
    } catch (e) {
      return rel;
    }
  }

  // Parse XML text into a Document.
  function parseXML(text) {
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  // Query helper: get all elements by local name regardless of namespace prefix.
  function els(node, localName) {
    const out = [];
    const all = node.getElementsByTagNameNS('*', localName);
    for (let i = 0; i < all.length; i++) out.push(all[i]);
    return out;
  }
  function firstEl(node, localName) {
    const e = els(node, localName);
    return e.length ? e[0] : null;
  }
  function text(node, localName) {
    const e = firstEl(node, localName);
    return e ? e.textContent.trim() : null;
  }

  class CalDAV {
    constructor(config) {
      // config: { url, username, password }
      this.url = config.url.replace(/\s+$/, '');
      this.username = config.username || '';
      this.password = config.password || '';
      this.auth = 'Basic ' + btoa(unescape(encodeURIComponent(this.username + ':' + this.password)));
    }

    async request(method, url, { depth, body, contentType } = {}) {
      const headers = {
        'Authorization': this.auth,
      };
      if (depth !== undefined) headers['Depth'] = String(depth);
      if (contentType) headers['Content-Type'] = contentType;
      const resp = await fetch(url, {
        method: method,
        headers: headers,
        body: body,
        // Auth is sent explicitly via header; avoid browser credential prompts.
        credentials: 'omit',
        redirect: 'follow',
      });
      return resp;
    }

    async propfind(url, depth, body) {
      const resp = await this.request('PROPFIND', url, {
        depth: depth,
        body: body,
        contentType: 'application/xml; charset=utf-8',
      });
      if (resp.status === 401) throw new Error('Authentication failed (401). Check username/password.');
      if (!resp.ok && resp.status !== 207) {
        throw new Error('PROPFIND failed: ' + resp.status + ' ' + resp.statusText);
      }
      const t = await resp.text();
      return parseXML(t);
    }

    // ---- Discovery -----------------------------------------------------
    // Find calendar collections that support VTODO.
    async discoverCollections() {
      // 1. current-user-principal
      let principal = null;
      try {
        const doc = await this.propfind(this.url, 0,
          '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>');
        const cup = firstEl(doc, 'current-user-principal');
        if (cup) principal = text(cup, 'href');
      } catch (e) { /* fall through to treating url as home */ }

      let homeURL = this.url;
      if (principal) {
        const principalURL = joinURL(this.url, principal);
        // 2. calendar-home-set
        try {
          const doc = await this.propfind(principalURL, 0,
            '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>');
          const home = firstEl(doc, 'calendar-home-set');
          const href = home ? text(home, 'href') : null;
          if (href) homeURL = joinURL(principalURL, href);
        } catch (e) { /* use url */ }
      }

      // 3. Enumerate collections under the home set.
      const collections = await this.listCollections(homeURL);
      if (collections.length) return collections;

      // Fallback: maybe the configured URL is itself a collection.
      const self = await this.listCollections(this.url);
      return self;
    }

    async listCollections(homeURL) {
      const body =
        '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">' +
        '<d:prop>' +
        '<d:resourcetype/>' +
        '<d:displayname/>' +
        '<c:supported-calendar-component-set/>' +
        '<cs:getctag/>' +
        '<ic:calendar-color/>' +
        '</d:prop></d:propfind>';
      const doc = await this.propfind(homeURL, 1, body);
      const responses = els(doc, 'response');
      const collections = [];
      responses.forEach((resp) => {
        const href = text(resp, 'href');
        if (!href) return;
        const url = joinURL(homeURL, href);
        // Must be a calendar resourcetype.
        const rt = firstEl(resp, 'resourcetype');
        const isCalendar = rt && els(rt, 'calendar').length > 0;
        if (!isCalendar) return;

        // Must support VTODO (if the property is present).
        const compSet = firstEl(resp, 'supported-calendar-component-set');
        let supportsTodo = true;
        if (compSet) {
          const comps = els(compSet, 'comp');
          if (comps.length) {
            supportsTodo = comps.some((c) => (c.getAttribute('name') || '').toUpperCase() === 'VTODO');
          }
        }
        if (!supportsTodo) return;

        collections.push({
          url: url,
          displayName: text(resp, 'displayname') || decodeURIComponent(href.replace(/\/$/, '').split('/').pop()) || 'Tasks',
          ctag: text(resp, 'getctag'),
          color: text(resp, 'calendar-color'),
        });
      });
      return collections;
    }

    // ---- ctag polling --------------------------------------------------
    async getCtag(collectionURL) {
      const doc = await this.propfind(collectionURL, 0,
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/><d:getetag/></d:prop></d:propfind>');
      return text(doc, 'getctag') || text(doc, 'getetag');
    }

    // Lightweight change signature: fetch only etags (no calendar-data) and
    // concatenate them. Used when the server does not support getctag.
    async fetchSignature(collectionURL) {
      const body =
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
        '<d:prop><d:getetag/></d:prop>' +
        '<c:filter><c:comp-filter name="VCALENDAR">' +
        '<c:comp-filter name="VTODO"/>' +
        '</c:comp-filter></c:filter>' +
        '</c:calendar-query>';
      const resp = await this.request('REPORT', collectionURL, {
        depth: 1,
        body: body,
        contentType: 'application/xml; charset=utf-8',
      });
      if (!resp.ok && resp.status !== 207) {
        throw new Error('REPORT (etags) failed: ' + resp.status);
      }
      const doc = parseXML(await resp.text());
      const pairs = [];
      els(doc, 'response').forEach((r) => {
        pairs.push((text(r, 'href') || '') + '=' + (text(r, 'getetag') || ''));
      });
      pairs.sort();
      return pairs.join('|');
    }

    // ---- Fetch VTODOs --------------------------------------------------
    async fetchTodos(collectionURL) {
      const body =
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
        '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
        '<c:filter><c:comp-filter name="VCALENDAR">' +
        '<c:comp-filter name="VTODO"/>' +
        '</c:comp-filter></c:filter>' +
        '</c:calendar-query>';
      const resp = await this.request('REPORT', collectionURL, {
        depth: 1,
        body: body,
        contentType: 'application/xml; charset=utf-8',
      });
      if (resp.status === 401) throw new Error('Authentication failed (401).');
      if (!resp.ok && resp.status !== 207) {
        throw new Error('REPORT failed: ' + resp.status + ' ' + resp.statusText);
      }
      const doc = parseXML(await resp.text());
      const responses = els(doc, 'response');
      const items = [];
      responses.forEach((r) => {
        const href = text(r, 'href');
        const etag = text(r, 'getetag');
        const data = text(r, 'calendar-data');
        if (!data || !/BEGIN:VTODO/i.test(data)) return;
        items.push({
          href: joinURL(collectionURL, href),
          etag: etag,
          data: data,
        });
      });
      return items;
    }

    // ---- Create / update -----------------------------------------------
    // Returns { etag } of the stored resource. Pass isNew=true for a
    // create-only PUT (If-None-Match: *). Updates use If-Match when an etag
    // is known and are sent unconditionally otherwise — sending
    // If-None-Match: * on an update would 409/412 against the existing
    // resource (e.g. completing a task created moments earlier whose etag
    // the server never exposed).
    async putTodo(url, icsText, etag, isNew) {
      const headers = {
        'Authorization': this.auth,
        'Content-Type': 'text/calendar; charset=utf-8',
      };
      if (etag) headers['If-Match'] = etag;
      else if (isNew) headers['If-None-Match'] = '*'; // create only if it doesn't exist
      const resp = await fetch(url, {
        method: 'PUT',
        headers: headers,
        body: icsText,
        credentials: 'omit',
      });
      if (resp.status === 401) throw new Error('Authentication failed (401).');
      if (!resp.ok) {
        const err = new Error('PUT failed: ' + resp.status + ' ' + resp.statusText);
        err.status = resp.status;
        throw err;
      }
      // Servers frequently omit the ETag on PUT responses, and even when they
      // send it, CORS hides it unless Access-Control-Expose-Headers lists it.
      // Fetch the fresh etag so later updates can use If-Match.
      let newEtag = resp.headers.get('ETag');
      if (!newEtag) {
        try { newEtag = await this.getResourceEtag(url); } catch (e) { newEtag = null; }
      }
      return { etag: newEtag };
    }

    // Current etag of a single resource.
    async getResourceEtag(url) {
      const doc = await this.propfind(url, 0,
        '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>');
      return text(doc, 'getetag');
    }

    async deleteTodo(url, etag) {
      const headers = { 'Authorization': this.auth };
      if (etag) headers['If-Match'] = etag;
      const resp = await fetch(url, {
        method: 'DELETE',
        headers: headers,
        credentials: 'omit',
      });
      if (resp.status === 401) throw new Error('Authentication failed (401).');
      if (!resp.ok && resp.status !== 404) throw new Error('DELETE failed: ' + resp.status + ' ' + resp.statusText);
      return true;
    }

    // Test the connection; returns true or throws.
    async test() {
      const resp = await this.request('OPTIONS', this.url, {});
      if (resp.status === 401) throw new Error('Authentication failed (401). Check credentials.');
      if (!resp.ok) {
        // Some servers reject OPTIONS; try a PROPFIND instead.
        await this.propfind(this.url, 0, '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>');
      }
      return true;
    }
  }

  CalDAV.joinURL = joinURL;
  global.CalDAV = CalDAV;
})(typeof window !== 'undefined' ? window : this);
