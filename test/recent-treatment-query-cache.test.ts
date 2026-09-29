import { describe, expect, it, vi } from "vitest";
import { RecentTreatmentQueryCache } from "../src/realtime/recent-treatment-query-cache";

describe("recent treatment ascending-prefix cache", () => {
  it("reloads a full prefix when time advances and reveals the next row", () => {
    const cache = new RecentTreatmentQueryCache<{ id: string; sort_time: number; updated_at: number }>();
    const rows = [10, 20, 30].map(updated_at => ({ id: String(updated_at), sort_time: updated_at, updated_at }));
    let lower = 0;
    const load = vi.fn(() => rows.filter(row => row.updated_at >= lower).slice(0, 2));
    expect([...cache.read(lower, 2, load)]).toEqual(rows.slice(0, 2));
    lower = 10;
    expect([...cache.read(lower, 2, load)]).toEqual(rows.slice(0, 2));
    expect(load).toHaveBeenCalledTimes(1);
    lower = 11;
    expect([...cache.read(lower, 2, load)]).toEqual(rows.slice(1));
    expect(load).toHaveBeenCalledTimes(2);
    lower = 0;
    expect([...cache.read(lower, 2, load)]).toEqual(rows.slice(0, 2));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("reuses exhausted short/empty results and clears after a mutation", () => {
    const cache = new RecentTreatmentQueryCache<{ id: string; sort_time: number; updated_at: number }>();
    const load = vi.fn(() => [{ id: "a", sort_time: 10, updated_at: 10 }]);
    expect([...cache.read(0, 2, load)]).toHaveLength(1);
    expect([...cache.read(11, 2, load)]).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    cache.clear();
    [...cache.read(11, 2, load)];
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache truncated, oversized, or invalidated cursors", () => {
    const cache = new RecentTreatmentQueryCache<{ id: string; sort_time: number; updated_at: number; body?: string }>();
    const load = vi.fn(() => [{ id: "a", sort_time: 10, updated_at: 10 }, { id: "b", sort_time: 20, updated_at: 20 }]);
    for (const _row of cache.read(0, 2, load)) break;
    [...cache.read(0, 2, load)];
    expect(load).toHaveBeenCalledTimes(2);
    cache.clear();
    const huge = vi.fn(() => [{ id: "a", sort_time: 10, updated_at: 10, body: "x".repeat(300_000) }]);
    [...cache.read(0, 2, huge)];
    [...cache.read(0, 2, huge)];
    expect(huge).toHaveBeenCalledTimes(2);
    cache.clear();
    for (const _row of cache.read(0, 2, load)) cache.clear();
    [...cache.read(0, 2, load)];
    expect(load).toHaveBeenCalledTimes(4);
  });
});
