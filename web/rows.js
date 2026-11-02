// Чистая часть плагина «Напоминания»: из снимка страницы - строки списка, тексты напоминаний, кулдаун. Без DOM.
export const CARD_MIN_AGE = 30 * 60;     // карточка без ответа показывается с получаса
export const CARD_MAX_AGE = 24 * 3600;   // старше суток ядро считает её устаревшей, в снимок такие не попадают
export const COOLDOWN = 15 * 60;         // «Напомнить» одной и той же строке - не чаще
export const LATE = 2 * 3600;            // после этого «ждёт …» подкрашено
export const STALE_MAX_AGE = 14 * 24 * 3600;   // карточка без ответа старше двух недель, как и запись «жду», уже никому не нужна
export const WAIT_MIN_AGE = 10 * 60;     // запись «жду слова владельца» показывается с 10 минут: сессия могла просто не дошла до карточки

const ASK_MAX = 200;
const clip = (s, n) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };

// короткая подпись роли: агент - до первого «:» его описания; хаб - «хаб»
export function roleOf(s) {
  if (s.kind === "hub") return "хаб";
  const about = String(s.about || "").trim();
  return clip(about.split(/[:.]/)[0], 40);
}

// Ждут слова текстом: сессия свободна, сторож поставил метку attention {since, p, ask, text}
export function textWaits(snap) {
  const out = [];
  for (const s of snap?.sessions || []) {
    const a = s.attention;
    if (!a || s.state !== "idle") continue;
    const tail = clip(a.text, 300);
    const ask = clip(a.ask, ASK_MAX) || (tail ? `…${tail.slice(-120)}` : "");
    out.push({ key: `a:${s.name}`, kind: "text", session: s.name, role: roleOf(s), since: Number(a.since) || 0,
      ask, tail: a.ask ? tail : "" });
  }
  return out.sort((x, y) => x.since - y.since || (x.session < y.session ? -1 : 1));
}

// Карточки без ответа: вопрос формой (AskUserQuestion) старше CARD_MIN_AGE и моложе CARD_MAX_AGE
export function cardWaits(snap, now) {
  const out = [];
  for (const s of snap?.sessions || []) {
    for (const p of s.pending || []) {
      if (p.tool !== "AskUserQuestion") continue;
      const since = Number(p.back_at || p.since) || 0;   // задана без владельца - считается с его возвращения
      const age = now - since;
      if (!since || age < CARD_MIN_AGE || age >= CARD_MAX_AGE) continue;
      const qs = (p.input && p.input.questions) || [];
      const first = qs[0] || {};
      const more = qs.length > 1 ? ` (+${qs.length - 1})` : "";
      const opts = (first.options || []).map((o) => String(o.label || "").replace(/\s*\(Recommended\)|\s*\(рекомендую\)/i, "").trim()).filter(Boolean);
      out.push({ key: `c:${s.name}:${p.id || p.request_id}`, kind: "card", session: s.name, role: roleOf(s), since, id: p.id || "",
        ask: clip(first.question, ASK_MAX) + more, tail: opts.length ? opts.join(" / ") : "" });
    }
  }
  return out.sort((x, y) => x.since - y.since || (x.session < y.session ? -1 : 1));
}

// Устаревшие карточки без ответа: отдаёт процесс плагина (asks.py), в снимке страницы их нет. Сверяем со снимком: сессия жива,
// вопрос не задан заново (открытая карточка с тем же текстом)
export function staleCards(asks, snap, now) {
  const by = new Map((snap?.sessions || []).map((s) => [s.name, s]));
  const out = [];
  for (const a of asks || []) {
    const s = by.get(a.session);
    const since = Number(a.since) || 0, age = now - since;
    if (!s || s.state === "removed" || !since || age < CARD_MAX_AGE || age >= STALE_MAX_AGE) continue;
    const open = (s.pending || []).some((p) => p.tool === "AskUserQuestion"
      && clip(((p.input && p.input.questions) || []).map((q) => q.question).join(" / "), ASK_MAX).toLowerCase() === String(a.question || "").toLowerCase());
    if (open) continue;
    out.push({ key: `s:${a.session}:${a.id}`, kind: "stale", session: a.session, role: roleOf(s), since, id: a.id || "",
      ask: clip(a.question, ASK_MAX), tail: (a.options || []).join(" / "), revived: !!a.revived });
  }
  return out.sort((x, y) => x.since - y.since || (x.session < y.session ? -1 : 1));
}

// Слово владельца в тексте «жду …»: владелец, owner или номер карточки qN. Цепочка «A -> B -> владелец» - сначала ждут других.
const OWNER = /владел|\bowner\b|\bq\d{3,}\b/i;
const CHAIN = /->|→|=>|›/;
const STANDBY = /нов(?:ых|ое|ой|ого)\s+(?:задач|задани|поручени|слов)/i;   // «жду новых задач владельца»: дежурство, не вопрос

export function isOwnerWait(text) {
  const t = String(text || "");
  return OWNER.test(t) && !CHAIN.test(t) && !STANDBY.test(t);
}

// Запись «жду слова владельца» (hub waiting) без карточки и метки сторожа. Свежая запись есть в снимке как waiting; stale - уже не ждёт
export function ownerWaits(snap, now) {
  const out = [];
  for (const s of snap?.sessions || []) {
    const w = s.waiting;
    if (!w || w.stale || !isOwnerWait(w.text)) continue;
    if (s.state === "removed" || s.state === "busy" || s.state === "starting" || s.status === "working") continue;
    if (s.attention || (s.pending || []).some((p) => p.tool === "AskUserQuestion")) continue;
    const since = Number(w.ts) || 0, age = now - since;
    if (!since || age < WAIT_MIN_AGE || age >= STALE_MAX_AGE) continue;
    out.push({ key: `w:${s.name}`, kind: "wait", session: s.name, role: roleOf(s), since, ask: clip(w.text, ASK_MAX), tail: "" });
  }
  return out.sort((x, y) => x.since - y.since || (x.session < y.session ? -1 : 1));
}

// «ждёт 52 мин», «ждёт 3 ч 10 мин», «ждёт 1 д 4 ч»
export function waitLabel(since, now) {
  const m = Math.max(0, Math.floor((now - since) / 60));
  if (m < 1) return "ждёт меньше минуты";
  if (m < 60) return `ждёт ${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `ждёт ${h} ч${m % 60 ? ` ${m % 60} мин` : ""}`;
  return `ждёт ${Math.floor(h / 24)} д${h % 24 ? ` ${h % 24} ч` : ""}`;
}

// Текст напоминания сессии: уходит как слово владельца (его кнопка), с action: сообщение не становится ответом на карточку
export function remindText(row) {
  if (row.kind === "card") {
    const id = row.id;
    return `Напоминание от владельца (кнопка «Напомнить» в плагине «Напоминания»): твоя карточка ${id || "с вопросом"} ещё ждёт его ответа. `
      + "Если она нужна - ничего не делай, он ответит. "
      + (id ? `Если уже не нужна (решено, дубль, устарела) - сними: hub question withdraw ${id} "<почему>"; если команда ответит, что такого вопроса нет, - ничего не делай.` : "Если уже не нужна - скажи об этом словами.");
  }
  if (row.kind === "stale") return reaskText(row);
  if (row.kind === "wait") {
    return "Напоминание от владельца (кнопка «Напомнить» в плагине «Напоминания»): у тебя отмечено, что ты ждёшь его слова "
      + `(«${clip(row.ask, 120)}»), а вопроса карточкой нет. Если слово нужно - задай вопрос карточкой с вариантами, контекст в самом вопросе. `
      + "Уже не ждёшь - сними отметку (hub waiting --clear) и ответь одним «\u2014» (такой ответ никому не уйдёт).";
  }
  return "Напоминание от владельца (кнопка «Напомнить» в плагине «Напоминания»): твой прошлый итог ждёт его слова, а вопроса карточкой нет. "
    + "Если слово нужно - задай вопрос карточкой с вариантами. Ничего не нужно - ответь одним «\u2014» (такой ответ никому не уйдёт).";
}

// Переспросить устаревшую карточку: по образцу ASK_EXPIRED ядра (PR #356) - задать заново формой, с контекстом в вопросе
export function reaskText(row) {
  return "Напоминание от владельца (кнопка «Переспросить» в плагине «Напоминания»): твой вопрос ему остался без ответа дольше суток - "
    + `карточка устарела, и к вопросу после неё никто не возвращался:\n- ${row.id || "вопрос"}: «${clip(row.ask, 200)}»\n`
    + "Решение владельца всё ещё нужно, чтобы двигаться дальше, - задай вопрос заново формой AskUserQuestion: контекст в самом вопросе "
    + "(старую карточку он мог не открывать, «см. выше» не сработает), по одному решению на вопрос. Вопрос уже решён (владелец ответил иначе, "
    + "решилось само, задача закрыта) или не нужен - ничего не спрашивай и ответь одним «\u2014»: такой ответ никому не уйдёт.";
}

// кулдаун: sent - {key: ts}; сколько секунд ещё нельзя нажимать
export function cooldownLeft(sent, key, now) {
  const t = Number(sent?.[key]) || 0;
  return Math.max(0, Math.ceil(COOLDOWN - (now - t)));
}

// «Напомнить всем»: по одной строке на сессию (метка сторожа раньше карточки), кому ещё можно
export function remindAllRows(rows, sent, now) {
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (seen.has(r.session) || cooldownLeft(sent, r.key, now)) continue;
    seen.add(r.session);
    out.push(r);
  }
  return out;
}

// «ответ уже ушёл» после напоминания: у такой строки метки больше нет - плагин ничего не помнит, кроме журнала действий
export function recent(log, n = 5) { return (log || []).slice(-n).reverse(); }
