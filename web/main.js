// «Напоминания»: сессии, что ждут слова владельца текстом без карточки (метка сторожа attention), и карточки без ответа.
// Данные - только снимок страницы; ответ, «Напомнить» и «Не жду» - обычные действия страницы от имени владельца.
import { cardWaits, cooldownLeft, LATE, recent, remindAllRows, remindText, textWaits, waitLabel } from "./rows.js";

const PLUGIN = "reminders", SENT = `${PLUGIN}.sent`, LOG = `${PLUGIN}.log`;
let hub = null, rootRef = null, timer = null, confirmAll = false, confirmTimer = null;
const el = (...a) => hub.el(...a);
const inputs = new Map();   // поле «ответить» по сессии: узел живёт между перерисовками (курсор и черновик)
const state = new Map();    // key строки -> {busy?, note?}: «Отправляю…» и ошибка
const cids = new Map();     // key -> client_id неудачной отправки: повтор не задвоит сообщение

function load(key, empty) { try { return JSON.parse(localStorage.getItem(key)) ?? empty; } catch { return empty; } }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим: без памяти */ } }
const sent = () => load(SENT, {});
const stamp = (key, now) => { const s = sent(); s[key] = now; for (const k of Object.keys(s)) if (now - s[k] > 3600) delete s[k]; save(SENT, s); };
const hm = (ts) => new Date(ts * 1000).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
const nowSec = () => Date.now() / 1000;
function note(session, what) { save(LOG, [...load(LOG, []), { ts: nowSec(), session, what }].slice(-20)); }

function typing() { const a = document.activeElement; return !!rootRef && rootRef.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) || !!rootRef?.querySelector("[contenteditable]:focus"); }
function redraw() { if (rootRef) draw(rootRef, hub.snapshot()); }
function set(key, value) { if (value) state.set(key, value); else state.delete(key); redraw(); }

async function remind(row) {
  if (state.get(row.key)?.busy) return;
  set(row.key, { busy: true });
  const cid = cids.get(row.key);
  const r = await hub.send({ session: row.session, text: remindText(row), action: true, ...(cid ? { client_id: cid } : {}) });
  if (r.ok) {
    cids.delete(row.key);
    stamp(row.key, nowSec());
    note(row.session, row.kind === "card" ? `напомнили про ${row.id || "карточку"}` : "напомнили");
    set(row.key, null);
    return;
  }
  if (r.client_id && r.receipt !== "refused") cids.set(row.key, r.client_id);
  set(row.key, { note: r.error || "Не дошло, нажмите ещё раз" });
}

async function dismiss(row) {
  set(row.key, { busy: true });
  const r = await hub.post("/api/dismiss", { session: row.session });
  if (r.error) return set(row.key, { note: r.error });
  note(row.session, "сняли метку");
  set(row.key, null);
}

async function remindAll() {
  confirmAll = false;
  clearTimeout(confirmTimer);
  for (const row of remindAllRows(allRows(hub.snapshot()), sent(), nowSec())) await remind(row);
  redraw();
}

function arm() {
  confirmAll = true;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => { confirmAll = false; redraw(); }, 8000);
  redraw();
}

const allRows = (snap) => [...textWaits(snap), ...cardWaits(snap, nowSec())];
const openSession = (name) => { location.hash = `#/s/${encodeURIComponent(name)}`; };

function button(label, cls, onClick, title) {
  const b = el("button", `btn small ${cls}`.trim(), label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function remindButton(row, now) {
  const left = cooldownLeft(sent(), row.key, now), st = state.get(row.key);
  if (st?.busy) { const b = button("Отправляю…", "", () => {}); b.disabled = true; return b; }
  if (left) {
    const b = button(`Напомнено ${hm(sent()[row.key])}`, "", () => {}, "Повторить можно через 15 минут после прошлого напоминания");
    b.disabled = true;
    return b;
  }
  return button("Напомнить", "", () => remind(row), "Сессия получит от вас напоминание и ответит карточкой или продолжит");
}

function answerField(row) {
  if (!inputs.has(row.session)) {
    inputs.set(row.session, hub.input({ to: row.session, key: row.session, placeholder: `Ответить ${row.session}…`,
      onSent: () => { note(row.session, "ответили"); inputs.delete(row.session); redraw(); } }));
  }
  return inputs.get(row.session).node;
}

function item(row, now) {
  const age = now - row.since;
  const box = el("article", `rm-item${age >= LATE ? " rm-old" : ""}`);
  const top = el("div", "rm-top");
  top.append(el("span", "rm-name", row.session));
  if (row.role) top.append(el("span", "rm-role", row.role));
  if (row.kind === "card") top.append(el("span", "rm-kind", row.id ? `карточка ${row.id}` : "карточка"));
  top.append(el("span", `rm-age${age >= LATE ? " rm-late" : ""}`, waitLabel(row.since, now)));
  box.append(top, el("p", "rm-ask", row.ask));
  if (row.tail) box.append(el("p", "rm-tail", row.tail));
  if (row.kind === "text") box.append(answerField(row));
  const acts = el("div", "rm-actions"), st = state.get(row.key);
  if (row.kind === "card") acts.append(button("Открыть карточку", "primary", () => openSession(row.session)));
  acts.append(remindButton(row, now));
  if (row.kind === "text") {
    const b = button("Не жду", "quiet", () => dismiss(row), "Снять метку «ответ?»: сессии ничего не пишется");
    b.disabled = !!st?.busy;
    acts.append(b, button("Открыть сессию", "quiet", () => openSession(row.session)));
  }
  if (st?.note) acts.append(el("span", "rm-note rm-warn", st.note));
  box.append(acts);
  return box;
}

function section(title, hint, rows, now) {
  const h = el("div", "rm-sect", title);
  h.append(el("small", null, hint));
  return [h, ...rows.map((r) => item(r, now))];
}

function draw(root, snap) {
  const now = nowSec(), text = textWaits(snap), cards = cardWaits(snap, now);
  const live = new Set(text.map((r) => r.session));
  for (const k of [...inputs.keys()]) if (!live.has(k)) inputs.delete(k);
  const total = text.length + cards.length;
  const wrap = el("div", "rm-view");
  const head = el("div", "rm-head");
  head.append(el("h2", null, "Напоминания"));
  head.append(el("span", "rm-note", total ? `${total} ждут вашего слова` : ""));
  head.append(el("span", "rm-spacer"));
  const targets = remindAllRows([...text, ...cards], sent(), now);
  const sessions = targets.length;
  if (total && confirmAll && sessions) {
    head.append(el("span", "rm-note", `Напомнить ${sessions} ${sessions === 1 ? "сессии" : "сессиям"}?`),
      button("Да", "primary", remindAll), button("Отмена", "quiet", () => { confirmAll = false; clearTimeout(confirmTimer); redraw(); }));
  } else if (total) {
    const b = button("Напомнить всем", "", arm, sessions ? "" : "Всем уже напомнили, повторить можно через 15 минут");
    b.disabled = !sessions;
    head.append(b);
  }
  wrap.append(head);
  wrap.append(el("p", "rm-lead", "Сессии, которые закончили ход и ждут вашего слова без вопроса карточкой, и карточки без ответа дольше получаса. "
    + "Такие ожидания не попадают в «Ждут вас»."));
  if (!total) wrap.append(el("p", "rm-empty", "Сейчас никто не ждёт вашего слова."));
  if (text.length) wrap.append(...section("Ждут слова текстом", "сторож хаба, вопроса формой нет", text, now));
  if (cards.length) wrap.append(...section("Карточки без ответа", "вопрос формой задан давно, не старше суток", cards, now));
  const log = recent(load(LOG, []));
  if (log.length) {
    const box = el("div", "rm-done");
    box.append(el("strong", null, "Недавно"));
    for (const e of log) box.append(el("span", null, `${e.session} - ${e.what}, ${hm(e.ts)}`));
    wrap.append(box);
  }
  root.replaceChildren(wrap);
}

function tile(root, snap) {
  const n = textWaits(snap).length + cardWaits(snap, nowSec()).length;
  if (!n) { root.replaceChildren(); return; }
  const b = el("button", "rm-tile");
  b.type = "button";
  b.setAttribute("aria-label", `Ждут вашего слова: ${n}`);
  b.append(hub.icon("clock"), el("span", "rm-tile-name", "Ждут вашего слова"), el("span", "rm-n", String(n)));
  b.addEventListener("click", () => hub.go(PLUGIN));
  root.replaceChildren(b);
}

export default function register(h) {
  hub = h;
  hub.addStyle("web/reminders.css");
  hub.addView({
    id: PLUGIN, title: "Напоминания", subtitle: "кто ждёт вашего слова", icon: "clock",
    render(root, snap) { rootRef = root; if (!typing()) draw(root, snap); },
    show(root) { rootRef = root; timer = setInterval(() => { if (!typing()) redraw(); }, 30000); },
    hide() { clearInterval(timer); timer = null; confirmAll = false; },
  });
  hub.addSlot("sidebar.tiles", { id: "waits", render: tile });
}
