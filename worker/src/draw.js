export class DrawError extends Error {}

function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return buffer[0] % max;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Returns [[giverId, receiverId], ...] for [{id, household}, ...].
 * Shuffles first, which is unbiased. Tightly constrained groups fall back to a
 * randomised bipartite matching, which finds a valid draw whenever one exists.
 */
export function makeDraw(people) {
  const n = people.length;
  if (n < 3) throw new DrawError("You need at least 3 people for a draw.");
  const counts = new Map();
  for (const p of people) counts.set(p.household, (counts.get(p.household) || 0) + 1);
  if (Math.max(...counts.values()) * 2 > n) {
    throw new DrawError(
      "One household has more than half of the people, so a draw is impossible. Add more people from other households.",
    );
  }

  const householdOf = new Map(people.map((p) => [p.id, p.household]));
  const ids = people.map((p) => p.id);
  for (let attempt = 0; attempt < 5000; attempt++) {
    const receivers = shuffle([...ids]);
    if (ids.every((id, i) => householdOf.get(id) !== householdOf.get(receivers[i]))) {
      return ids.map((id, i) => [id, receivers[i]]);
    }
  }

  const options = new Map(
    ids.map((g) => [g, shuffle(ids.filter((r) => householdOf.get(r) !== householdOf.get(g)))]),
  );
  const giverFor = new Map();
  const assign = (giver, seen) => {
    for (const receiver of options.get(giver)) {
      if (seen.has(receiver)) continue;
      seen.add(receiver);
      if (!giverFor.has(receiver) || assign(giverFor.get(receiver), seen)) {
        giverFor.set(receiver, giver);
        return true;
      }
    }
    return false;
  };
  for (const giver of shuffle([...ids])) {
    if (!assign(giver, new Set())) throw new DrawError("No valid draw exists for this group.");
  }
  return [...giverFor].map(([receiver, giver]) => [giver, receiver]);
}
