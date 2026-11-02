// Чистая часть плагина «Напоминания»: из снимка страницы - строки списка, тексты напоминаний, кулдаун. Без DOM.
export const CARD_MIN_AGE = 30 * 60;     // карточка без ответа показывается с получаса
export const CARD_MAX_AGE = 24 * 3600;   // старше суток ядро считает её устаревшей, в снимок такие не попадают
export const COOLDOWN = 15 * 60;         // «Напомнить» одной и той же строке - не чаще
export const LATE = 2 * 3600;            // после этого «ждёт …» подкрашено

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
  return "Напоминание от владельца (кнопка «Напомнить» в плагине «Напоминания»): твой прошлый итог ждёт его слова, а вопроса карточкой нет. "
    + "Если слово нужно - задай вопрос карточкой с вариантами. Ничего не нужно - ответь одним «\u2014» (такой ответ никому не уйдёт).";
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
