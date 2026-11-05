import assert from "node:assert/strict";
import test from "node:test";
import { cardWaits, cooldownLeft, COOLDOWN, isOwnerWait, ownerWaits, reaskText, remindAllRows, remindText, staleCards, staleFromPosts, textWaits, waitLabel } from "../web/rows.js";

const NOW = 1_800_000_000;
const sess = (name, extra = {}) => ({ name, state: "idle", pending: [], attention: null, ...extra });
const card = (id, since, extra = {}) => ({ id, request_id: `r-${id}`, tool: "AskUserQuestion", since,
  input: { questions: [{ question: "Делаем так?", options: [{ label: "Да (рекомендую)" }, { label: "Нет" }] }] }, ...extra });

test("text waits: only idle sessions with the mark, the oldest first", () => {
  const snap = { sessions: [
    sess("b", { attention: { since: NOW - 60, ask: "Слить?", text: "итог" } }),
    sess("a", { attention: { since: NOW - 600, ask: "", text: "длинный итог без вопроса" } }),
    sess("busy", { state: "busy", attention: { since: NOW - 900, ask: "x", text: "y" } }),
    sess("quiet"),
  ] };
  const rows = textWaits(snap);
  assert.deepEqual(rows.map((r) => r.session), ["a", "b"]);
  assert.equal(rows[0].ask, "…длинный итог без вопроса");
  assert.equal(rows[0].tail, "");
  assert.equal(rows[1].tail, "итог");
});

test("cards: not younger than half an hour, not older than a day, only question forms", () => {
  const snap = { sessions: [sess("s", { pending: [
    card("q1", NOW - 10 * 60), card("q2", NOW - 40 * 60), card("q3", NOW - 25 * 3600),
    { ...card("q4", NOW - 3600), tool: "Bash" },
    card("q5", NOW - 3600, { back_at: NOW - 60 }),
  ] })] };
  assert.deepEqual(cardWaits(snap, NOW).map((r) => r.id), ["q2"]);
  assert.equal(cardWaits(snap, NOW)[0].tail, "Да / Нет");
});

test("a card with several questions says how many more", () => {
  const p = card("q1", NOW - 3600);
  p.input.questions.push({ question: "Второй?" }, { question: "Третий?" });
  assert.match(cardWaits({ sessions: [sess("s", { pending: [p] })] }, NOW)[0].ask, /\(\+2\)$/);
});

test("wait label", () => {
  assert.equal(waitLabel(NOW - 20, NOW), "ждёт меньше минуты");
  assert.equal(waitLabel(NOW - 52 * 60, NOW), "ждёт 52 мин");
  assert.equal(waitLabel(NOW - 190 * 60, NOW), "ждёт 3 ч 10 мин");
  assert.equal(waitLabel(NOW - 28 * 3600, NOW), "ждёт 1 д 4 ч");
});

test("cooldown and remind-all: one row per session, none within the cooldown", () => {
  const rows = [{ key: "a:x", session: "x" }, { key: "c:x:q1", session: "x" }, { key: "a:y", session: "y" }, { key: "a:z", session: "z" }];
  const sent = { "a:y": NOW - 60, "a:z": NOW - COOLDOWN - 1 };
  assert.equal(cooldownLeft(sent, "a:y", NOW), COOLDOWN - 60);
  assert.equal(cooldownLeft(sent, "a:z", NOW), 0);
  assert.deepEqual(remindAllRows(rows, sent, NOW).map((r) => r.key), ["a:x", "a:z"]);
});

test("reminder texts: a card names its number and the way to withdraw it; the silent answer is the core's dash", () => {
  const c = remindText({ kind: "card", id: "q7" });
  assert.match(c, /q7/);
  assert.match(c, /hub question withdraw q7/);
  assert.match(remindText({ kind: "text" }), /«—»/);
});

const DAY = 24 * 3600;
const asked = (id, ago, extra = {}) => ({ id, session: "alpha-lab", question: "Делаем так? Отчёты «Приложения A» уже живут в панели", options: ["Да", "Нет"], since: NOW - ago, revived: false, ...extra });

test("stale cards: older than a day and younger than two weeks, from the plugin process", () => {
  const snap = { sessions: [sess("alpha-lab", { about: "Разработчик: приложения команды" })] };
  const rows = staleCards([asked("q1001", 58 * 3600), asked("q1", 3 * 3600), asked("q2", 15 * DAY), asked("q3", 13 * DAY)], snap, NOW);
  assert.deepEqual(rows.map((r) => r.id), ["q3", "q1001"]);
  assert.equal(rows[1].kind, "stale");
  assert.equal(rows[1].role, "Разработчик");
  assert.equal(rows[1].tail, "Да / Нет");
});

test("stale cards: a gone session and a question already asked again are dropped, the core's revival is kept", () => {
  const again = { tool: "AskUserQuestion", id: "q9", since: NOW - 60, input: { questions: [{ question: "делаем ТАК?   Отчёты «Приложения A» уже живут в панели" }] } };
  const snap = { sessions: [sess("alpha-lab", { pending: [again] }), sess("gone", { state: "removed" }), sess("other")] };
  assert.deepEqual(staleCards([asked("q1", 2 * DAY), asked("q2", 2 * DAY, { session: "gone" }), asked("q3", 2 * DAY, { session: "nobody" })], snap, NOW), []);
  const rows = staleCards([asked("q4", 2 * DAY, { session: "other", revived: true })], snap, NOW);
  assert.equal(rows[0].revived, true);
});

test("re-ask text follows the core's ASK_EXPIRED: ask again with a form, a lone dash if not needed", () => {
  const t = reaskText({ id: "q1001", ask: "Делаем так?" });
  assert.match(t, /q1001/);
  assert.match(t, /формой AskUserQuestion/);
  assert.match(t, /контекст в самом вопросе/);
  assert.match(t, /одним «\u2014»/);
  assert.equal(remindText({ kind: "stale", id: "q1", ask: "x" }), reaskText({ id: "q1", ask: "x" }));
});

// примеры текстов hub waiting
const LIVE_YES = [
  "ответ владельца q1002: снимать кадры «Приложения A» - d2002",
  "слово владельца «снимай» по кадрам «Приложения A» (q1002: позже) - d2002",
  "ответа владельца на q1003 (коммиты сайдбара и правки меню); сетки скриншотов от beta-lab - d2004",
  "слова владельца о снятии паузы «Приложения B» (q1004) - d2005",
  "owner decision on the release",
];
const LIVE_NO = [
  "Google: ответ на апелляцию Play до 7 дней",
  "владелец q1005 (планшеты в 2.0) -> alpha-lab финальные исходники -> beta-lab кадры планшета -> «да» владельца -> загрузка в магазин",
  "одобрения сборки в меню-баре - d2006; ответа про два устройства для спайка - d2007",
  "сборка «Приложения C» от alpha-lab и ответ review - d2003",
  "новых задач владельца по «Приложению D»; направление открыто по его просьбе, всё сделано и запушено",
  "",
];

test("owner wait rule: the owner's word yes, other people's and chains no", () => {
  for (const t of LIVE_YES) assert.equal(isOwnerWait(t), true, t);
  for (const t of LIVE_NO) assert.equal(isOwnerWait(t), false, t);
});

test("owner waits: only a free live session without a card or a watchdog mark, fresh write, not stale", () => {
  const w = (text, extra = {}) => ({ text, ts: NOW - 3600, ...extra });
  const snap = { sessions: [
    sess("alpha", { waiting: w(LIVE_YES[0]) }),
    sess("with-card", { waiting: w(LIVE_YES[0]), pending: [card("q1002", NOW - 60)] }),
    sess("marked", { waiting: w(LIVE_YES[0]), attention: { since: NOW - 60 } }),
    sess("gone", { waiting: w(LIVE_YES[0]), state: "removed" }),
    sess("busy", { waiting: w(LIVE_YES[0]), state: "busy" }),
    sess("old-stale", { waiting: w(LIVE_YES[0], { stale: NOW - 60 }) }),
    sess("not-owner", { waiting: w(LIVE_NO[0]) }),
    sess("chain", { waiting: w(LIVE_NO[1]) }),
    sess("fresh", { waiting: w(LIVE_YES[0], { ts: NOW - 60 }) }),
    sess("ancient", { waiting: w(LIVE_YES[0], { ts: NOW - 20 * DAY }) }),
    sess("quiet"),
  ] };
  const rows = ownerWaits(snap, NOW);
  assert.deepEqual(rows.map((r) => r.session), ["alpha"]);
  assert.equal(rows[0].kind, "wait");
  assert.equal(rows[0].key, "w:alpha");
  assert.match(rows[0].ask, /^ответ владельца q1002/);
});

test("owner wait reminder names the wait and the way to clear it", () => {
  const t = remindText({ kind: "wait", ask: LIVE_YES[0] });
  assert.match(t, /ответ владельца q1002/);
  assert.match(t, /hub waiting --clear/);
  assert.match(t, /«\u2014»/);
});

test("stale list comes from the plugin process's latest post in its channel, not from a session's post", () => {
  const list = (ids) => JSON.stringify({ kind: "stale", asks: ids.map((id) => ({ id })) });
  const posts = [
    { id: "p1", by: "плагин acme:reminders", text: list(["q1"]) },
    { id: "p2", by: "плагин reminders", text: list(["q2", "q3"]) },
    { id: "p3", by: "alpha-lab", text: list(["q9"]) },
    { id: "p4", by: "плагин other:reminders-x", text: list(["q8"]) },
    { id: "p5", by: "плагин acme:reminders", text: "не json" },
  ];
  assert.deepEqual(staleFromPosts(posts, "reminders").map((a) => a.id), ["q2", "q3"]);
  assert.deepEqual(staleFromPosts(posts.slice(0, 1), "reminders").map((a) => a.id), ["q1"]);
  assert.deepEqual(staleFromPosts([{ by: "plugin reminders", text: list([]) }], "reminders"), []);
  assert.equal(staleFromPosts(posts.slice(2), "reminders"), null);
  assert.equal(staleFromPosts([], "reminders"), null);
});

test("stale cards: one the snapshot already shows answered, or of a session that handed in, is dropped before the next post", () => {
  const snap = { sessions: [sess("alpha-lab", { answered: [{ request_id: "r-q1" }] }), sess("done", { retired: true })] };
  const rows = staleCards([asked("q1", 2 * DAY, { request_id: "r-q1" }), asked("q2", 2 * DAY, { request_id: "r-q2" }),
    asked("q3", 2 * DAY, { session: "done" })], snap, NOW);
  assert.deepEqual(rows.map((r) => r.id), ["q2"]);
});
