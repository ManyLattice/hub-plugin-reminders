"""Чистая часть процесса плагина «Напоминания»: из состояния ядра - карточки владельцу, которые устарели без ответа.
Ядро держит такую карточку в sess["asks"] навсегда (owner.open_asks прячет её через ASK_TTL), в снимок страницы она не попадает.
Без ввода-вывода: время и состояние приходят аргументами."""
import hashlib

TTL = 24 * 3600          # owner.ASK_TTL: старше - ядро карточку не показывает
MAX_AGE = 14 * 24 * 3600  # старше двух недель вопрос уже никому не нужен: не показываем
OVER = ("replied", "stopped", "closed", "archived")   # задача карточки закончена (core/askexpired.py): ждать ответа некому
GONE = ("removed", "retired")                          # сессии нет, или сдала задачу и спит: сообщение её не разбудит
TEXT = 200


def question(ask):
    """Текст вопроса как в ядре (owner.question_text)."""
    qs = (ask.get("input") or {}).get("questions") or []
    return " / ".join(str(q.get("question", "")) for q in qs if isinstance(q, dict)) or "вопрос"


def key(ask):
    """Ключ вопроса для sess["revived"]: как в core/askexpired.key. Должен совпадать с ядром, иначе «ядро переспросило» не найдётся."""
    return hashlib.sha1(" ".join(question(ask).lower().split()).encode()).hexdigest()[:12]


def since(ask):
    return ask.get("back_at") or ask.get("since")


def waits_return(ask):
    return bool(ask.get("away")) and ask.get("back_at") is None


def options(ask):
    qs = (ask.get("input") or {}).get("questions") or []
    first = qs[0] if qs and isinstance(qs[0], dict) else {}
    out = []
    for o in first.get("options") or []:
        label = str(o.get("label") or "").replace(" (Recommended)", "").replace(" (рекомендую)", "").strip() if isinstance(o, dict) else ""
        if label:
            out.append(label)
    return out


def _clip(s, n):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n - 1] + "…"


def stale(state, now):
    """Карточки без ответа старше суток и моложе двух недель: [{id, request_id, session, question, options, since, revived}], старые первыми.
    Не показываем: отвеченные, сессию removed/retired, задачу в closed/archived/replied/stopped, ожидание возвращения владельца,
    вопрос, который сессия уже задала заново (он открыт сейчас)."""
    out = []
    delegations = state.get("delegations") or {}
    for name, sess in (state.get("sessions") or {}).items():
        if sess.get("state") in GONE:
            continue
        asks = [a for a in sess.get("asks") or [] if isinstance(a, dict) and a.get("tool") == "AskUserQuestion" and since(a)]
        answered = {r.get("request_id") for r in sess.get("answered") or [] if isinstance(r, dict)}
        live = {key(p) for p in sess.get("pending") or [] if isinstance(p, dict) and p.get("tool") == "AskUserQuestion"}
        live |= {key(a) for a in asks if not waits_return(a) and now - since(a) < TTL}
        revived = sess.get("revived") or {}
        seen = set()
        for a in sorted(asks, key=since, reverse=True):
            age = now - since(a)
            k = key(a)
            if waits_return(a) or age < TTL or age >= MAX_AGE or a.get("request_id") in answered:
                continue
            if (delegations.get(a.get("delegation") or "") or {}).get("state") in OVER:
                continue
            if k in live or k in seen:
                continue
            seen.add(k)
            out.append({"id": a.get("id") or "", "request_id": a.get("request_id") or "", "session": name, "question": _clip(question(a), TEXT),
                        "options": options(a), "since": since(a), "revived": k in revived})
    return sorted(out, key=lambda r: (r["since"], r["session"]))
