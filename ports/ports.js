/* Ports – read-only Cockpit module.
 * Collects data from: ss, podman (every user that has container storage), systemd sockets, ps.
 * Nothing here changes anything on the system. */
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let ROWS = [];
let SORT = { key: "port", dir: 1 };
const warnings = [];

/* ---------- helpers ---------- */

function run(cmd, opts) {
    return cockpit.spawn(cmd, Object.assign({ err: "message" }, opts || {}));
}

function splitAddr(local) {
    // "0.0.0.0:22", "[::]:443", "*:80", "127.0.0.53%lo:53"
    const i = local.lastIndexOf(":");
    let addr = local.slice(0, i).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    return { addr, port: parseInt(local.slice(i + 1), 10) };
}

function scope(addr) {
    if (["0.0.0.0", "::", "*", ""].includes(addr)) return "all interfaces";
    if (addr.startsWith("127.") || addr === "::1") return "localhost only";
    return addr;
}

/* ---------- collectors ---------- */

async function getListeners() {
    let out;
    try {
        out = await run(["ss", "-tulpnH"], { superuser: "try" });
    } catch (e) {
        warnings.push("Could not run ss: " + e.message);
        return [];
    }
    const list = [];
    for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const f = line.trim().split(/\s+/);
        const proto = f[0].startsWith("tcp") ? "tcp" : "udp";
        const { addr, port } = splitAddr(f[4]);
        if (!port) continue;
        const procs = [];
        const m = line.match(/users:\(\((.*)\)\)/);
        if (m) {
            for (const p of m[1].split("),(")) {
                const pm = p.match(/"([^"]+)",pid=(\d+)/);
                if (pm) procs.push({ name: pm[1], pid: pm[2] });
            }
        }
        list.push({ proto, addr, port, procs });
    }
    return list;
}

async function getProcInfo(pids) {
    const info = {};
    if (!pids.length) return info;
    try {
        const out = await run(["ps", "-o", "pid=,user=,unit=", "-p", pids.join(",")], { superuser: "try" });
        for (const line of out.split("\n")) {
            const f = line.trim().split(/\s+/);
            if (f.length >= 2) info[f[0]] = { user: f[1], unit: f[2] && f[2] !== "-" ? f[2] : "" };
        }
    } catch (e) { /* ps exits non-zero if some pid vanished; ignore */ }
    return info;
}

// Lists containers for root and every user that already has podman storage.
// Read-only: only runs `podman ps`, and skips users who never used podman so no storage gets created.
const PODMAN_SCRIPT = `
command -v podman >/dev/null 2>&1 || exit 0
if [ "$(id -u)" = 0 ]; then
  echo "@@USER root"; podman ps -a --format json 2>/dev/null || echo "[]"
  for d in /run/user/*; do
    uid=\${d##*/}; [ "$uid" = 0 ] && continue
    ent=$(getent passwd "$uid") || continue
    u=\${ent%%:*}; home=$(echo "$ent" | cut -d: -f6)
    [ -d "$home/.local/share/containers" ] || continue
    out=$(runuser -u "$u" -- env XDG_RUNTIME_DIR="$d" podman ps -a --format json 2>/dev/null) || continue
    echo "@@USER $u"; echo "$out"
  done
else
  echo "@@USER $(id -un)"; podman ps -a --format json 2>/dev/null || echo "[]"
fi
`;

async function getContainers() {
    let out;
    try {
        out = await cockpit.script(PODMAN_SCRIPT, [], { superuser: "try", err: "message" });
    } catch (e) {
        warnings.push("Could not list Podman containers: " + e.message);
        return [];
    }
    const result = [];
    for (const chunk of out.split("@@USER ").slice(1)) {
        const nl = chunk.indexOf("\n");
        const user = chunk.slice(0, nl).trim();
        let data = [];
        try { data = JSON.parse(chunk.slice(nl + 1) || "[]") || []; } catch (e) { continue; }
        for (const c of data) {
            const name = (c.Names && c.Names[0]) || (c.Id || "").slice(0, 12);
            const running = (c.State || "").toLowerCase() === "running";
            for (const p of c.Ports || []) {
                const n = p.range || 1;
                for (let i = 0; i < n; i++) {
                    result.push({
                        user, name, running, state: c.State || "",
                        image: c.Image || "",
                        proto: (p.protocol || "tcp").toLowerCase(),
                        hostIp: p.host_ip || "",
                        hostPort: p.host_port + i,
                        ctrPort: p.container_port + i,
                    });
                }
            }
        }
    }
    return result;
}

async function getSockets() {
    try {
        const out = await run(["systemctl", "list-sockets", "--all", "--no-legend", "--no-pager"]);
        const list = [];
        for (const line of out.split("\n")) {
            const f = line.trim().split(/\s+/);
            if (f.length < 2) continue;
            const m = f[0].match(/:(\d+)$/);
            if (!m) continue;
            list.push({ port: parseInt(m[1], 10), unit: f[1], activates: f[2] || "" });
        }
        return list;
    } catch (e) { return []; }
}

/* ---------- merge ---------- */

async function collect() {
    warnings.length = 0;
    const [listeners, containers, sockets] = await Promise.all([getListeners(), getContainers(), getSockets()]);
    const pids = [...new Set(listeners.flatMap(l => l.procs.map(p => p.pid)))];
    const procInfo = await getProcInfo(pids);

    const rows = new Map();   // key proto:port
    const rowFor = (proto, port) => {
        const k = proto + ":" + port;
        if (!rows.has(k)) rows.set(k, { proto, port, addrs: new Set(), procs: [], containers: [],
                                        units: new Set(), users: new Set(), listening: false });
        return rows.get(k);
    };

    for (const l of listeners) {
        const r = rowFor(l.proto, l.port);
        r.listening = true;
        r.addrs.add(scope(l.addr));
        for (const p of l.procs) {
            if (!r.procs.some(x => x.pid === p.pid)) r.procs.push(p);
            const pi = procInfo[p.pid];
            if (pi) { r.users.add(pi.user); if (pi.unit) r.units.add(pi.unit); }
        }
    }

    for (const c of containers) {
        const r = rowFor(c.proto, c.hostPort);
        r.containers.push(c);
        r.users.add(c.user);
        if (!r.listening) r.addrs.add(scope(c.hostIp));
    }

    for (const s of sockets) {
        for (const proto of ["tcp", "udp"]) {
            const r = rows.get(proto + ":" + s.port);
            if (r) r.units.add(s.unit + (s.activates ? " → " + s.activates : ""));
        }
    }

    const HELPERS = /^(rootlessport|rootlessport-ch|pasta|pasta\.avx2|slirp4netns|conmon|netavark)$/;

    ROWS = [...rows.values()].map(r => {
        const running = r.containers.filter(c => c.running);
        const procNames = r.procs.map(p => p.name);
        const onlyHelpers = procNames.length && procNames.every(n => HELPERS.test(n));
        let status, owner, kind;

        if (r.listening) {
            status = "listening";
            if (running.length) {
                kind = "container"; owner = running.map(c => c.name).join(", ");
            } else if (r.containers.length && onlyHelpers) {
                kind = "container"; owner = r.containers.map(c => c.name).join(", ");
            } else {
                // Real service/process. A stopped container that also wants this port = conflict.
                if (r.containers.length) status = "conflict";
                const units = [...r.units].filter(u => !/^(session-|user@|init\.scope)/.test(u));
                kind = units.length ? "service" : "process";
                owner = units.length ? units.join(", ") : [...new Set(procNames)].join(", ") || "unknown";
            }
        } else {
            status = "reserved";
            kind = "container";
            owner = r.containers.map(c => c.name).join(", ");
        }

        const maps = r.containers.map(c =>
            `${c.hostPort} → ${c.name}:${c.ctrPort}/${c.proto}` + (c.running ? "" : ` (${c.state})`));

        return {
            port: r.port, proto: r.proto, status, kind, owner, maps,
            stoppedNote: status === "conflict" ? "Stopped container also maps this port: " +
                r.containers.map(c => c.name).join(", ") : "",
            user: [...r.users].join(", "),
            addrs: [...r.addrs].join(", "),
            // Group worker processes: "nginx ×14" instead of 14 separate entries
            procList: Object.entries(r.procs.reduce((acc, p) => {
                (acc[p.name] = acc[p.name] || []).push(p.pid); return acc;
            }, {})).map(([name, pids]) => pids.length > 1 ? `${name} ×${pids.length}` : `${name} (${pids[0]})`),
            procs: r.procs.map(p => `${p.name} ${p.pid}`).join(" "),
        };
    });
}

/* ---------- render ---------- */

let PAGE = 0;

// "1234" → single port, "1234-1500" / "1234:1500" / "1234 to 1500" → range, anything else → text
function parseQuery(raw) {
    const q = raw.trim().toLowerCase();
    let m = q.match(/^(\d{1,5})\s*(?:-|:|\.\.|to)\s*(\d{1,5})$/);
    if (m) {
        let a = Math.max(1, +m[1]), b = Math.min(65535, +m[2]);
        if (a > b) [a, b] = [b, a];
        return { type: "range", from: a, to: b };
    }
    m = q.match(/^\d{1,5}$/);
    if (m && +q >= 1 && +q <= 65535) return { type: "range", from: +q, to: +q };
    return { type: "text", q };
}

// Free ports only make sense when you've asked about specific ports.
function freeRows(from, to, proto) {
    const used = { tcp: new Set(), udp: new Set() };
    for (const r of ROWS) used[r.proto].add(r.port);
    const protos = proto ? [proto] : ["tcp", "udp"];
    const out = [];
    for (let p = from; p <= to; p++) {
        const freeIn = protos.filter(x => !used[x].has(p));
        if (!freeIn.length) continue;
        out.push({ port: p, proto: freeIn.join("+"), status: "free", kind: "", owner: "",
                   maps: [], user: "", addrs: "", procList: [], procs: "", stoppedNote: "" });
    }
    return out;
}

function render() {
    const query = parseQuery($("filter").value);
    const proto = $("proto").value;
    const status = $("status").value;
    const isRange = query.type === "range";

    let rows = ROWS.filter(r =>
        (!proto || r.proto === proto) &&
        (!status || r.status === status) &&
        (isRange ? r.port >= query.from && r.port <= query.to
                 : !query.q || [r.port, r.proto, r.status, r.owner, r.user, r.procs, r.addrs, r.maps.join(" ")]
                       .join(" ").toLowerCase().includes(query.q)));

    let free = [];
    if (isRange) free = freeRows(query.from, query.to, proto);
    if (isRange && (!status || status === "free")) rows = rows.concat(free);
    if (!isRange && status === "free") rows = [];

    // Range summary bar
    const bar = $("rangebar");
    if (isRange) {
        const inRange = ROWS.filter(r => r.port >= query.from && r.port <= query.to && (!proto || r.proto === proto));
        const c = s => inRange.filter(r => r.status === s).length;
        const label = query.from === query.to ? `Port <b>${query.from}</b>` : `Ports <b>${query.from}–${query.to}</b>`;
        bar.innerHTML = `<span>${label}${proto ? " (" + proto.toUpperCase() + ")" : ""}:</span>` +
            `<span class="pill p-listening" data-st="listening">${c("listening")} in use</span>` +
            `<span class="pill p-reserved" data-st="reserved">${c("reserved")} reserved</span>` +
            `<span class="pill p-conflict" data-st="conflict">${c("conflict")} conflicts</span>` +
            `<span class="pill p-free" data-st="free">${free.length} free</span>`;
        bar.classList.remove("hidden");
    } else {
        bar.classList.add("hidden");
    }

    const k = SORT.key;
    rows.sort((a, b) => {
        const av = a[k], bv = b[k];
        const c = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
        return (c || a.port - b.port) * SORT.dir;
    });

    // Paging
    const per = parseInt($("perPage").value, 10);
    const pages = per ? Math.max(1, Math.ceil(rows.length / per)) : 1;
    PAGE = Math.min(PAGE, pages - 1);
    const start = per ? PAGE * per : 0;
    const shown = per ? rows.slice(start, start + per) : rows;
    $("pageInfo").textContent = rows.length
        ? `${start + 1}–${start + shown.length} of ${rows.length}` + (pages > 1 ? ` · page ${PAGE + 1}/${pages}` : "")
        : "0 results";
    $("prevPage").disabled = PAGE === 0;
    $("nextPage").disabled = PAGE >= pages - 1;

    const LABEL = { listening: "In use", reserved: "Reserved", conflict: "Conflict", free: "Free" };
    const dash = '<span class="muted">—</span>';

    $("rows").innerHTML = shown.length ? shown.map(r => r.status === "free" ? `
        <tr>
          <td class="port">${r.port}</td>
          <td>${r.proto.toUpperCase().replace("+", " + ")}</td>
          <td><span class="pill p-free">Free</span></td>
          <td class="muted">Available</td>
          <td>${dash}</td><td>${dash}</td><td>${dash}</td><td>${dash}</td>
        </tr>` : `
        <tr>
          <td class="port">${r.port}</td>
          <td>${r.proto.toUpperCase()}</td>
          <td><span class="pill p-${r.status}">${LABEL[r.status]}</span></td>
          <td><span class="kind">${esc(r.kind)}</span>${esc(r.owner)}
              ${r.stoppedNote ? `<div class="muted small">${esc(r.stoppedNote)}</div>` : ""}</td>
          <td class="mono nowrap">${r.maps.length ? r.maps.map(esc).join("<br>") : dash}</td>
          <td>${esc(r.user) || dash}</td>
          <td class="nowrap">${esc(r.addrs) || dash}</td>
          <td>${r.procList.length
                ? `<div class="chips">${r.procList.map(p => `<span class="chip">${esc(p)}</span>`).join("")}</div>`
                : dash}</td>
        </tr>`).join("")
        : `<tr><td colspan="8" class="empty">${status === "free" && !isRange
              ? "Type a port or range (e.g. 8000-8100) to see free ports."
              : "No ports match your search."}</td></tr>`;

    const count = s => ROWS.filter(r => r.status === s).length;
    $("cListening").textContent = count("listening");
    $("cReserved").textContent = count("reserved");
    $("cConflict").textContent = count("conflict");
    $("cTotal").textContent = ROWS.length;

    document.querySelectorAll("th[data-sort]").forEach(th => {
        th.classList.toggle("asc", th.dataset.sort === SORT.key && SORT.dir === 1);
        th.classList.toggle("desc", th.dataset.sort === SORT.key && SORT.dir === -1);
    });

    $("warnings").innerHTML = warnings.map(w => `<div class="warn">${esc(w)}</div>`).join("");
}

/* Follow Cockpit's light/dark setting (Session → Style), falling back to the OS preference. */
function applyTheme() {
    let style = "auto";
    try { style = localStorage.getItem("shell:style") || "auto"; } catch (e) { /* ignore */ }
    const dark = style === "dark" ||
        (style === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
}
applyTheme();
window.addEventListener("storage", applyTheme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

async function refresh() {
    $("refresh").disabled = true;
    $("refresh").classList.add("spin");
    try {
        await collect();
        render();
        $("updated").textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) {
        $("rows").innerHTML = `<tr><td colspan="8" class="empty">${esc(e.message || e)}</td></tr>`;
    }
    $("refresh").disabled = false;
    $("refresh").classList.remove("spin");
}

/* ---------- wire up ---------- */

const resetAndRender = () => { PAGE = 0; render(); };
$("filter").addEventListener("input", resetAndRender);
$("proto").addEventListener("change", resetAndRender);
$("status").addEventListener("change", resetAndRender);
$("perPage").addEventListener("change", resetAndRender);
$("prevPage").addEventListener("click", () => { PAGE--; render(); });
$("nextPage").addEventListener("click", () => { PAGE++; render(); });
$("refresh").addEventListener("click", refresh);
// Clicking a pill in the range summary filters to that status (click again to clear)
$("rangebar").addEventListener("click", e => {
    const st = e.target.dataset && e.target.dataset.st;
    if (!st) return;
    $("status").value = $("status").value === st ? "" : st;
    resetAndRender();
});
document.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    SORT = { key, dir: SORT.key === key ? -SORT.dir : 1 };
    render();
}));

cockpit.transport.wait(refresh);
