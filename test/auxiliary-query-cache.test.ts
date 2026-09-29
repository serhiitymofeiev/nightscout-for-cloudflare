import { describe, expect, it, vi } from "vitest";
import { AuxiliaryQueryCache } from "../src/realtime/auxiliary-query-cache";

type Row = { id: string; sort_time: number; body?: string };
const rows = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({ id: String(index), sort_time: index }));
function take<T>(source: Iterable<T>, count: number): T[] {
  const result: T[] = [];
  for (const item of source) {
    result.push(item);
    if (result.length === count) break;
  }
  return result;
}

describe("bounded auxiliary raw query prefixes", () => {
  it("reuses budget-stopped prefixes and refills larger budgets without duplicates", () => {
    const cache = new AuxiliaryQueryCache<Row>();
    const data = rows(5);
    const load = vi.fn(() => data);
    expect(take(cache.read("history", 0, load), 2)).toEqual(data.slice(0, 2));
    expect(take(cache.read("history", 0, load), 2)).toEqual(data.slice(0, 2));
    expect(load).toHaveBeenCalledTimes(1);
    expect([...cache.read("history", 0, load)]).toEqual(data);
    expect(load).toHaveBeenCalledTimes(2);
    expect([...cache.read("history", 0, load)]).toEqual(data);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("preserves a DESC LIMIT selection output in ascending order as the lower bound advances", () => {
    const cache = new AuxiliaryQueryCache<Row>();
    const data = rows(6);
    const load = vi.fn((lower: number) => data.filter(row => row.sort_time >= lower).slice(-3));
    expect([...cache.read("newest-three", 0, () => load(0))]).toEqual(data.slice(3));
    expect([...cache.read("newest-three", 4, () => load(4))]).toEqual(data.slice(4));
    expect(load).toHaveBeenCalledTimes(1);
    expect([...cache.read("newest-three", 6, () => load(6))]).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    // A backwards window reloads the original SQL selection.
    expect([...cache.read("newest-three", 0, () => load(0))]).toEqual(data.slice(3));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refills ASC LIMIT suffixes repeatedly without exceeding the original limit", () => {
    const cache = new AuxiliaryQueryCache<Row>();
    const data = rows(8);
    const load = vi.fn((lower: number) => data.filter(row => row.sort_time >= lower).slice(0, 3));
    for (const lower of [0, 1, 2, 4, 5, 6, 7, 8]) {
      expect([...cache.read("oldest-three", lower, () => load(lower), row => row.sort_time, 3, true)])
        .toEqual(data.filter(row => row.sort_time >= lower).slice(0, 3));
    }
    const calls = load.mock.calls.length;
    expect([...cache.read("oldest-three", 9, () => load(9), row => row.sort_time, 3, true)]).toEqual([]);
    expect(load).toHaveBeenCalledTimes(calls);
  });

  it("reuses a small ASC budget while still finding previously unseen rows after the boundary moves", () => {
    const cache = new AuxiliaryQueryCache<Row>();
    const data = rows(105);
    const load = vi.fn((lower: number) => data.filter(row => row.sort_time >= lower).slice(0, 100));
    expect(take(cache.read("recent", 0, () => load(0), row => row.sort_time, 100, true), 3)).toEqual(data.slice(0, 3));
    expect(take(cache.read("recent", 1, () => load(1), row => row.sort_time, 100, true), 2)).toEqual(data.slice(1, 3));
    expect(load).toHaveBeenCalledTimes(1);
    expect([...cache.read("recent", 1, () => load(1), row => row.sort_time, 100, true)]).toEqual(data.slice(1, 101));
    expect(load).toHaveBeenCalledTimes(2);
    expect([...cache.read("recent", 2, () => load(2), row => row.sort_time, 100, true)]).toEqual(data.slice(2, 102));
  });

  it("does not repopulate an invalidated generation or cache a throwing cursor as complete", () => {
    const cache = new AuxiliaryQueryCache<Row>();
    const data = rows(2);
    const load = vi.fn(function* () {
      yield data[0]!;
      cache.clear();
      yield data[1]!;
    });
    expect([...cache.read("rows", 0, load)]).toEqual(data);
    expect([...cache.read("rows", 0, load)]).toEqual(data);
    expect(load).toHaveBeenCalledTimes(2);
    const fail = function* () { yield data[0]!; throw new Error("synthetic query failure"); };
    expect(() => [...cache.read("failed", 0, fail)]).toThrow("synthetic query failure");
    expect([...cache.read("failed", 0, () => data)]).toEqual(data);
  });

  it("bounds oversized entries and the key count without changing returned rows", () => {
    const cache = new AuxiliaryQueryCache<Row>();
    const large = [{ id: "oversize", sort_time: 1, body: "x".repeat(300_000) }];
    const load = vi.fn(() => large);
    expect([...cache.read("oversize", 0, load)]).toEqual(large);
    expect([...cache.read("oversize", 0, load)]).toEqual(large);
    expect(load).toHaveBeenCalledTimes(2);
    const small = vi.fn(() => rows(1));
    for (let key = 0; key < 33; key++) [...cache.read(`key-${key}`, 0, small)];
    expect(small).toHaveBeenCalledTimes(33);
    [...cache.read("key-32", 0, small)];
    expect(small).toHaveBeenCalledTimes(33);
    [...cache.read("key-0", 0, small)];
    expect(small).toHaveBeenCalledTimes(34);
  });

  it("retains a safe prefix before an oversized row and separates incompatible limits", () => {
    const cache = new AuxiliaryQueryCache<Row>();
    const data = [{ id: "small", sort_time: 1 }, { id: "large", sort_time: 2, body: "x".repeat(300_000) }];
    const load = vi.fn(() => data);
    expect([...cache.read("large-tail", 0, load)]).toEqual(data);
    expect(take(cache.read("large-tail", 0, load), 1)).toEqual(data.slice(0, 1));
    expect(load).toHaveBeenCalledTimes(1);
    expect([...cache.read("large-tail", 0, load)]).toEqual(data);
    expect(load).toHaveBeenCalledTimes(2);
    const limited = rows(10);
    for (const limit of [5, 2, 3, 5]) {
      expect([...cache.read("variable-limit", 0, () => limited.slice(0, limit), row => row.sort_time, limit, true)])
        .toEqual(limited.slice(0, limit));
    }
  });

  it("matches fresh queries across alternating budgets and forwards/backwards windows", () => {
    for (const ascending of [false, true]) {
      const cache = new AuxiliaryQueryCache<Row>();
      const data = rows(16);
      let random = 7;
      for (let iteration = 0; iteration < 120; iteration++) {
        random = (random * 16807) % 2147483647;
        const lower = random % 20 - 2;
        const budget = random % 7 + 1;
        const matching = data.filter(row => row.sort_time >= lower);
        const expected = ascending ? matching.slice(0, 5) : matching.slice(-5);
        expect(take(cache.read("query", lower, () => expected, row => row.sort_time, 5, ascending), budget))
          .toEqual(expected.slice(0, budget));
      }
    }
  });
});
