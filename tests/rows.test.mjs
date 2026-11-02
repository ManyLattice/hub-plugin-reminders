import assert from "node:assert/strict";
import test from "node:test";
import { cardWaits, cooldownLeft, COOLDOWN, remindAllRows, remindText, textWaits, waitLabel } from "../web/rows.js";

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
