import assert from "node:assert/strict";
import test from "node:test";
import { DrawError, makeDraw } from "../src/draw.js";

function assertValid(people, pairs) {
  const household = new Map(people.map((p) => [p.id, p.household]));
  assert.equal(new Set(pairs.map(([g]) => g)).size, people.length);
  assert.equal(new Set(pairs.map(([, r]) => r)).size, people.length);
  for (const [giver, receiver] of pairs) assert.notEqual(household.get(giver), household.get(receiver));
}

test("random groups always produce a valid draw or a clear error", () => {
  for (let run = 0; run < 1000; run++) {
    const n = 3 + Math.floor(Math.random() * 23);
    const people = Array.from({ length: n }, (_, id) => ({ id, household: Math.floor(Math.random() * 6) }));
    const counts = {};
    for (const p of people) counts[p.household] = (counts[p.household] || 0) + 1;
    if (Math.max(...Object.values(counts)) * 2 > n) assert.throws(() => makeDraw(people), DrawError);
    else assertValid(people, makeDraw(people));
  }
});

test("tightest possible group", () => {
  const people = Array.from({ length: 100 }, (_, id) => ({ id, household: id < 50 ? "a" : "b" }));
  assertValid(people, makeDraw(people));
});

test("impossible group is rejected", () => {
  assert.throws(() => makeDraw([{ id: 1, household: "a" }, { id: 2, household: "a" }, { id: 3, household: "b" }]), DrawError);
});
