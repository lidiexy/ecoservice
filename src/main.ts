import "basecoat-css/basecoat";
import "basecoat-css/drawer";
import "basecoat-css/combobox";
import { listen } from "@tauri-apps/api/event";
import {
  TEMPLATES,
  containerAction,
  containerLogs,
  listServices,
  portInUse,
  serviceStats,
  startService,
  type Action,
  type Service,
  type ServiceType,
  type Stats,
} from "./services";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const list = $<HTMLUListElement>("#services");
const msg = $<HTMLParagraphElement>("#msg");
const title = $<HTMLHeadingElement>("#services-title");
const drawer = $<HTMLDialogElement>("#drawer");
const logsDrawer = $<HTMLDialogElement>("#logs");
const logsTitle = $<HTMLHeadingElement>("#logs-title");
const logsBody = $<HTMLPreElement>("#logs-body");
// Basecoat combobox: selection lives in the root's hidden input; setValue() is added by its JS.
type Combobox = HTMLDivElement & { setValue(v: string): void };
const typeBox = $<Combobox>("#type-box");
const typeInput = $<HTMLInputElement>("#type");
let selectedType: ServiceType = "postgres";
const port = $<HTMLInputElement>("#port");
const nameInput = $<HTMLInputElement>("#name");
const image = $<HTMLInputElement>("#image");
const persist = $<HTMLInputElement>("#persist");
const portMsg = $<HTMLParagraphElement>("#port-msg");
const startBtn = $<HTMLButtonElement>("#start");
const TYPES = Object.keys(TEMPLATES) as ServiceType[];

let services: Service[] = [];
let stats: Record<string, Stats> = {};
let starting = ""; // service being started, for the download-progress label
let logsFor = ""; // container whose logs are open
let logsTimer = 0;
const cardPorts = {} as Record<ServiceType, number>; // port each card will launch on

// Static icon markup only (never user data).
const svg = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="${fill ? "currentColor" : "none"}" stroke="${fill ? "none" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', true),
  start: svg('<path d="M8 5v14l11-7z"/>', true),
  restart: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>'),
  logs: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  rm: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};

function iconButton(icon: keyof typeof ICONS, label: string, onClick: () => void, variant = "outline", cls = "") {
  const b = document.createElement("button");
  b.className = `btn ${cls}`;
  b.dataset.variant = variant;
  b.dataset.size = "icon-sm";
  b.innerHTML = ICONS[icon];
  b.title = label;
  b.setAttribute("aria-label", label);
  b.onclick = onClick;
  return b;
}

function chip(text: string, cls = "") {
  const c = document.createElement("span");
  c.className = `badge ${cls}`;
  c.dataset.variant = "outline";
  c.textContent = text;
  return c;
}

// Returns why `p` can't be used for `t`, or "" if it's free.
async function portProblem(t: ServiceType, p: number): Promise<string> {
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "Enter a port between 1 and 65535.";
  const existing = services.find((s) => Number(s.port) === p);
  if (existing) return `Port ${p} is used by ${existing.label || existing.serviceType}${existing.running ? "" : " (stopped)"}.`;
  if (await portInUse(p)) return `Port ${p} is already in use.`;
  if (t === "rabbitmq") {
    if (p > 55535) return "RabbitMQ port must be ≤ 55535 (dashboard uses port + 10000).";
    if (await portInUse(p + 10000)) return `Dashboard port ${p + 10000} is in use.`;
  }
  return "";
}

// Next usable port at or after `from`, or null. ponytail: linear scan of 50 ports, plenty for a dev box.
async function nextFreePort(t: ServiceType, from: number): Promise<number | null> {
  for (let p = from; p < from + 50 && p <= 65535; p++) if (!(await portProblem(t, p))) return p;
  return null;
}

async function checkPort() {
  const [t, p] = [selectedType, port.valueAsNumber];
  const problem = await portProblem(t, p);
  const suggestion = problem && Number.isInteger(p) ? await nextFreePort(t, p + 1) : null;
  if (t !== selectedType || p !== port.valueAsNumber) return; // stale: user changed input meanwhile
  port.setAttribute("aria-invalid", String(!!problem)); // drives the success/danger border
  port.parentElement!.toggleAttribute("data-invalid", !!problem);
  portMsg.textContent = problem + (suggestion ? ` Try ${suggestion}.` : "");
  startBtn.disabled = !!problem;
}

// Runs a backend call, shows its result or error, then re-syncs the list.
async function run(label: string, call: () => Promise<string>) {
  msg.textContent = `${label}…`;
  try {
    msg.textContent = await call();
  } catch (e) {
    msg.textContent = `Error: ${e}`;
  }
  await refresh();
}

function start(t: ServiceType, p: string, img: string, name = "", keep = true) {
  starting = name || t;
  layers.clear();
  return run(`Starting ${starting} on ${p}`, () => startService(t, p, img, name, keep));
}

function act(s: Service, action: Action) {
  const verb = { start: "Starting", stop: "Stopping", restart: "Restarting", rm: "Deleting" }[action];
  return run(`${verb} ${s.label || s.serviceType}`, () => containerAction(s.name, action));
}

function renderServices() {
  list.replaceChildren(
    ...services.map((s) => {
      const li = document.createElement("li");
      li.className = s.running ? "running" : "stopped";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.title = s.running ? "Running" : "Stopped";
      const logo = document.createElement("img");
      logo.src = TEMPLATES[s.serviceType]?.logo ?? "";
      logo.alt = "";
      logo.className = "size-7";
      const name = document.createElement("span");
      name.className = "truncate text-base font-semibold";
      name.textContent = s.label || s.serviceType;
      const portEl = document.createElement("span");
      portEl.className = "text-muted-foreground tabular-nums";
      portEl.textContent = `:${s.port}`;
      const status = document.createElement("span");
      status.className = "text-muted-foreground text-sm";
      status.textContent = s.status;
      const metrics = document.createElement("span");
      metrics.className = "flex flex-wrap justify-end gap-1.5";
      const st = stats[s.name];
      metrics.append(chip(s.image));
      if (s.running && st) metrics.append(chip(`CPU: ${st.cpu}`), chip(`MEM: ${st.mem}`));
      const actions = document.createElement("span");
      actions.className = "flex gap-1.5";
      actions.append(
        s.running
          ? iconButton("stop", "Stop", () => act(s, "stop"), "destructive")
          : iconButton("start", "Start", () => act(s, "start"), "outline", "go"),
        s.running
          ? iconButton("restart", "Restart", () => act(s, "restart"))
          : iconButton("rm", "Delete container (data folder kept)", () => act(s, "rm")),
        iconButton("logs", "Logs", () => openLogs(s)),
        iconButton("copy", "Copy connection string", () => copyUrl(s)),
      );
      li.append(dot, logo, name, portEl, status, metrics, actions);
      return li;
    }),
  );
  title.hidden = !services.length;
}

async function copyUrl(s: Service) {
  const url = TEMPLATES[s.serviceType].url(s.port);
  try {
    await navigator.clipboard.writeText(url);
    msg.textContent = `Copied ${url}`;
  } catch (e) {
    msg.textContent = `Copy failed: ${e}`;
  }
}

// Cards launch on their default port, or the next free one (flagged with a yellow badge).
async function renderCards() {
  for (const t of TYPES) {
    const free = await nextFreePort(t, TEMPLATES[t].port);
    if (free) cardPorts[t] = free;
    const card = document.querySelector<HTMLElement>(`.card[data-type="${t}"]`)!;
    const badge = card.querySelector<HTMLElement>(".warn")!;
    const moved = free !== TEMPLATES[t].port;
    badge.hidden = !moved;
    badge.textContent = free ? `${TEMPLATES[t].port} busy → ${free}` : "No free port nearby";
    card.querySelector<HTMLButtonElement>("button")!.disabled = !free;
  }
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    services = await listServices();
    renderServices();
    // stats take ~1-2s; render the list first, then fill in CPU/MEM
    stats = await serviceStats().catch(() => ({}));
    renderServices();
    await renderCards();
    if (drawer.open) await checkPort();
  } catch (e) {
    msg.textContent = `Error: ${e}`;
  } finally {
    refreshing = false;
  }
}

function fillDefaults(t: ServiceType) {
  selectedType = t;
  typeBox.setValue(t); // fires "change"; the listener ignores it since t is already selected
  port.value = String(TEMPLATES[t].port);
  image.value = TEMPLATES[t].image;
  checkPort();
}

// Basecoat drawers are native <dialog>s: Esc and backdrop click call .close().
function closePanels() {
  drawer.close();
  logsDrawer.close();
}

function openDrawer() {
  fillDefaults(selectedType);
  drawer.showModal();
  typeInput.focus();
}

async function loadLogs() {
  const name = logsFor;
  const atBottom = logsBody.scrollHeight - logsBody.scrollTop - logsBody.clientHeight < 40;
  let text: string;
  try {
    text = (await containerLogs(name)) || "(no output yet)";
  } catch (e) {
    text = `Error: ${e}`;
  }
  if (name !== logsFor) return; // closed or switched meanwhile
  logsBody.textContent = text;
  if (atBottom) logsBody.scrollTop = logsBody.scrollHeight;
}

function openLogs(s: Service) {
  logsFor = s.name;
  logsTitle.textContent = `Logs — ${s.label || s.serviceType} :${s.port}`;
  logsBody.textContent = "Loading…";
  logsDrawer.showModal();
  logsBody.focus();
  clearInterval(logsTimer);
  loadLogs().then(() => (logsBody.scrollTop = logsBody.scrollHeight));
  logsTimer = window.setInterval(loadLogs, 2000); // ponytail: polls tail 300; stream `docker logs -f` if this lags
}

$<HTMLDivElement>("#cards").replaceChildren(
  ...TYPES.map((t) => {
    const tpl = TEMPLATES[t];
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.type = t;
    card.dataset.size = "sm";
    const header = document.createElement("header");
    header.className = "flex! items-center gap-3";
    const logo = document.createElement("img");
    logo.src = tpl.logo;
    logo.alt = "";
    logo.className = "size-12";
    const h3 = document.createElement("h3");
    h3.textContent = tpl.title;
    h3.className = "text-base font-semibold leading-none";
    const def = document.createElement("p");
    def.textContent = `Default: ${tpl.port}`;
    def.className = "text-muted-foreground";
    const head = document.createElement("div");
    head.className = "grid gap-1";
    head.append(h3, def);
    header.append(logo, head);
    const section = document.createElement("section");
    section.className = "flex flex-wrap gap-1.5";
    const badge = chip("", "warn");
    badge.hidden = true;
    section.append(chip(`docker: ${tpl.image}`), badge);
    const footer = document.createElement("footer");
    footer.className = "mt-auto"; // pins Launch to the bottom so all cards align
    const btn = document.createElement("button");
    btn.className = "btn w-full";
    btn.textContent = "Launch";
    btn.onclick = () => start(t, String(cardPorts[t] ?? tpl.port), tpl.image);
    footer.append(btn);
    card.append(header, section, footer);
    return card;
  }),
);

// `docker pull` lines look like "<layerId>: Pulling fs layer" ... "<layerId>: Pull complete".
// ponytail: per-layer counts only; byte-level progress needs the Docker Engine API.
const layers = new Map<string, boolean>();
listen<string>("pull-progress", ({ payload }) => {
  const [, id, status] = payload.match(/^([0-9a-f]{12}): (.+)$/) ?? [];
  if (!id) return;
  if (status === "Pulling fs layer") layers.set(id, false);
  if (status === "Pull complete" || status === "Already exists") layers.set(id, true);
  const done = [...layers.values()].filter(Boolean).length;
  msg.textContent = `Downloading ${starting} image: ${done}/${layers.size} layers`;
});

$<HTMLFormElement>("#start-form").addEventListener("submit", (e) => {
  e.preventDefault();
  closePanels();
  start(selectedType, port.value, image.value.trim(), nameInput.value.trim(), persist.checked);
  nameInput.value = "";
});
typeBox.addEventListener("change", (e) => {
  const v = (e as CustomEvent<{ value: string }>).detail?.value as ServiceType;
  if (v in TEMPLATES && v !== selectedType) fillDefaults(v);
});
port.addEventListener("input", checkPort);
$("#add-btn").addEventListener("click", openDrawer);
document.querySelectorAll<HTMLButtonElement>(".close").forEach((b) => (b.onclick = closePanels));
logsDrawer.addEventListener("close", () => {
  clearInterval(logsTimer);
  logsFor = "";
});

(window as any).basecoat?.initAll(); // init now so typeBox.setValue exists before DOMContentLoaded
fillDefaults("postgres");
refresh();
setInterval(refresh, 5000); // ponytail: polling keeps uptime/stats fresh; `docker events` stream if this gets heavy
