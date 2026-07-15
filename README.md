# Tasks — a client-side CalDAV VTODO app

A minimal, Google Tasks–style task manager that talks directly to a CalDAV
server from the browser. No build step, no backend, no dependencies — just
static HTML/CSS/JS and browser storage.

## Features

- **Connection setup** — enter server URL, username, password (stored in this
  browser's `localStorage` only).
- **Collapsible sidebar** listing every calendar collection that holds VTODOs.
  An **All Tasks** entry appears first and aggregates every list.
- **Sorting** — overdue tasks first (by priority, then due date), then the rest
  (by priority, then due date).
- **Task rows** — round completion checkbox on the left, title with **due-date**
  and **repeat** badges, and a tappable **priority** flag on the right that
  cycles none → low → medium → high → none.
- **Detail view** with **Edit** and **Delete** (with confirmation).
- **Add / Edit form** — title, priority, due date, repeat rules (every *n*
  days/weeks/months/years, ending never / on a date / after *n* occurrences),
  description, and target list (defaults to the last-used list).
- **Completed tasks** are hidden behind a **Show/Hide completed** toggle.
- **Live sync** — the server is queried on open and then polled continuously
  (default every 5 s) using `getctag`, with an automatic etag-signature
  fallback for servers that don't support it. Changes made elsewhere appear
  without reloading.
- **Recurring tasks** roll forward to the next occurrence when completed, until
  their `COUNT`/`UNTIL` limit is reached.

## Running

Open `index.html` in a browser (double-click or serve the folder statically),
then click the ⚙ gear to enter your CalDAV connection. Serving over `http(s)`
(e.g. `npx serve .` or `python -m http.server`) is recommended over `file://`.

## Progressive Web App

The app is installable and works offline:

- **`manifest.webmanifest`** — name, colors, and icons (`icons/`), so browsers
  offer an **Install** / **Add to Home Screen** action and launch it in a
  standalone window.
- **`sw.js`** — a service worker that precaches the app shell (HTML/CSS/JS/icons)
  with a stale-while-revalidate strategy. CalDAV requests are never intercepted,
  so live sync is unaffected. The shell loads instantly and offline; task data
  still needs the network to sync.

**Secure-context requirement:** service workers and installation only work over
**HTTPS**, or on **`http://localhost`** / `127.0.0.1`. Over a plain-HTTP LAN
address (e.g. `http://192.168.x.x:8234`) the browser disables the service worker
and won't offer installation — put the app behind TLS for full PWA behavior. The
app itself still runs fine without it.

### Icons

`icons/icon.svg` is the master (a white checkmark on a blue rounded square).
The PNGs (`icon-192/512`, `maskable-192/512`, `apple-touch-icon`, `favicon-32`)
are rendered from it. To regenerate after editing the SVG, use any SVG
rasterizer, e.g. with ImageMagick + librsvg:

```sh
magick -background none icons/icon.svg -resize 512x512 icons/icon-512.png
```

## Running with Docker

The repo ships a tiny nginx-based image that serves the static app. It takes two
environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `BIND_IP` | `0.0.0.0` | IP the server binds to inside the container |
| `PORT`    | `8234`   | Port the server listens on |

Build and run with defaults:

```sh
docker build -t tasklist .
docker run -d --name tasklist -p 8234:8234 tasklist
# open http://localhost:8234
```

Custom IP/port (remember to publish the same container port):

```sh
docker run -d --name tasklist -e BIND_IP=0.0.0.0 -e PORT=9000 -p 9000:9000 tasklist
```

Or with Compose (reads `BIND_IP`/`PORT` from the shell or a `.env` file and
maps the port automatically):

```sh
docker compose up -d --build          # defaults: 0.0.0.0:8234
PORT=9000 docker compose up -d --build # custom port
```

## ⚠️ CORS — read this if the connection fails

Browsers enforce the same-origin policy on `fetch()`. Because this app is
"entirely client-side," it makes CalDAV requests (`PROPFIND`, `REPORT`, `PUT`,
`DELETE`) directly from the page's origin to your server. The **server must
return permissive CORS headers**, or the browser will block the requests:

```
Access-Control-Allow-Origin: <the app's origin>   (or *)
Access-Control-Allow-Methods: GET, PUT, DELETE, PROPFIND, REPORT, OPTIONS
Access-Control-Allow-Headers: Authorization, Depth, Content-Type, If-Match, If-None-Match
Access-Control-Allow-Credentials: true            (if not using *)
```

The server must also answer the preflight `OPTIONS` request for these.

Ways to satisfy this:
- Configure CORS on the CalDAV server (Nextcloud, Baïkal, Radicale, etc.).
- Put a reverse proxy (nginx/Caddy) in front that adds the headers.
- Host this app on the **same origin** as the CalDAV server (no CORS needed).

This is a constraint of the client-only requirement, not of the app logic.

## Priority mapping

App level ↔ iCalendar `PRIORITY` (RFC 5545): none = (omitted), high = 1,
medium = 5, low = 9. Values 1–4 read back as high, 6–9 as low.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell and modals |
| `css/styles.css` | Google Tasks–like styling, responsive |
| `js/ical.js` | iCalendar VTODO parse/serialize + RRULE helpers |
| `js/caldav.js` | CalDAV protocol (discovery, REPORT, PUT/DELETE, polling) |
| `js/app.js` | UI, state, sorting, live sync |

## Security note

Credentials are kept in `localStorage` in plain text so the app can reconnect
without prompting. Use it only on trusted devices. Click **Disconnect** in
settings to erase them.
