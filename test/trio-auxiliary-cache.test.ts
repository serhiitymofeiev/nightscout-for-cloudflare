import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { SqliteDocumentRepository } from "../src/document-repository";
import { AuxiliaryQueryCache } from "../src/realtime/auxiliary-query-cache";
import { RecentTreatmentQueryCache } from "../src/realtime/recent-treatment-query-cache";

type Row = { id: string; body: string; sort_time: number; updated_at: number };
type Snapshot = { treatments: Record<string, unknown>[]; profiles: Record<string, unknown>[]; food: Record<string, unknown>[] };
type Internals = {
  realtimeSnapshot(at: number, frame: boolean, mode: string): Snapshot;
  realtimeAuxiliaryQueries: Record<"treatments" | "profile" | "food", AuxiliaryQueryCache<Row>>;
  recentTreatmentQueries: RecentTreatmentQueryCache<Row>;
  activeProfileFromSwitch(at: number): string | null;
  activeProfileSwitchCache: unknown;
  cachedAuxiliaryRows(statement: string, bindings: SqlStorageValue[]): Iterable<Row>;
  recordDataMutationInTransaction(collection: string): void;
  realtime: { recordApi3StorageMutationInTransaction(event: unknown): void };
};
const id = (value: number) => value.toString(16).padStart(24, "0");
const day = 86_400_000;
const treatment = (value: number, at: number, eventType = "Note") => ({
  _id: id(value), created_at: new Date(at).toISOString(), eventType, notes: "synthetic cache fixture",
});

function verifyAgainstSql(internal: Internals, at: number, frame = false): Snapshot {
  const cached = internal.realtimeSnapshot(at, frame, "ddata");
  const committed = internal.realtimeAuxiliaryQueries;
  const committedRecent = internal.recentTreatmentQueries;
  internal.realtimeAuxiliaryQueries = {
    treatments: new AuxiliaryQueryCache<Row>(),
    profile: new AuxiliaryQueryCache<Row>(),
    food: new AuxiliaryQueryCache<Row>(),
  };
  internal.recentTreatmentQueries = new RecentTreatmentQueryCache<Row>();
  try {
    expect(internal.realtimeSnapshot(at, frame, "ddata")).toEqual(cached);
  } finally {
    internal.realtimeAuxiliaryQueries = committed;
    internal.recentTreatmentQueries = committedRecent;
  }
  return cached;
}

describe("Trio auxiliary snapshot query reuse", () => {
  it("preserves populated histories, newest-1000 selection, moving windows and explicit frames", async () => {
    const stub = env.ENTRY_STORE.getByName(`trio-aux-history-${crypto.randomUUID()}`);
    const now = Date.now();
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const internal = instance as unknown as Internals;
      const repository = new SqliteDocumentRepository(state.storage);
      state.storage.transactionSync(() => {
        for (let index = 1; index <= 1_105; index++) {
          repository.createLegacyDocument("treatments", treatment(index, now - index * 60_000));
        }
        repository.createLegacyDocument("treatments", treatment(2_000, now - 2.5 * day));
        repository.createLegacyDocument("treatments", treatment(2_001, now + 3_600_000));
        repository.createLegacyDocument("treatments", treatment(2_002, now - 62 * day, "Sensor Start"));
        repository.createLegacyDocument("treatments", {
          ...treatment(2_003, now - 372 * day, "Profile Switch"), duration: 0, profile: "synthetic",
        });
        repository.createLegacyDocument("profile", {
          _id: id(3_001), startDate: new Date(now - day).toISOString(),
          defaultProfile: "synthetic", store: { synthetic: {} },
        });
        repository.createLegacyDocument("food", { _id: id(4_001), name: "synthetic food", carbs: 10 });
        // Keep old backfill out of the separate 15-minute recent-mutation loader.
        state.storage.sql.exec("UPDATE documents SET updated_at = ? WHERE collection = 'treatments'", now - day);
      });
      // Direct repository seeding intentionally has no production mutation callbacks.
      for (const cache of Object.values(internal.realtimeAuxiliaryQueries)) cache.clear();
      internal.recentTreatmentQueries.clear();
      const first = verifyAgainstSql(internal, now);
      expect(first.treatments.some(row => row._id === id(2_002))).toBe(true);
      expect(first.treatments.some(row => row._id === id(2_003))).toBe(true);
      expect(first.profiles).toHaveLength(1);
      expect(first.food).toHaveLength(1);
      for (const at of [now + 1, now + day, now + 3 * day, now - day, now]) {
        verifyAgainstSql(internal, at);
        verifyAgainstSql(internal, at, true);
      }
      // A framed response never introduces the future treatment.
      expect(verifyAgainstSql(internal, now, true).treatments.some(row => row._id === id(2_001))).toBe(false);
    });
  });

  it("invalidates empty and populated results on legacy/API3 mutation, delete, rollback and eviction", async () => {
    const stub = env.ENTRY_STORE.getByName(`trio-aux-mutations-${crypto.randomUUID()}`);
    const now = Date.now();
    const finalSnapshot = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internals;
      verifyAgainstSql(internal, now);
      await instance.createDocuments("treatments", JSON.stringify([treatment(1, now - 10 * day, "Sensor Change")]));
      expect(verifyAgainstSql(internal, now).treatments.some(row => row._id === id(1))).toBe(true);
      await instance.createDocuments("profile", JSON.stringify([{
        _id: id(2), startDate: new Date(now - day).toISOString(),
        defaultProfile: "first", store: { first: {} },
      }]));
      expect(verifyAgainstSql(internal, now).profiles[0]?.defaultProfile).toBe("first");
      await instance.saveDocuments("profile", JSON.stringify([{
        _id: id(2), startDate: new Date(now - day).toISOString(),
        defaultProfile: "updated", store: { updated: {} },
      }]));
      expect(verifyAgainstSql(internal, now).profiles[0]?.defaultProfile).toBe("updated");
      await instance.createDocuments("food", JSON.stringify([{ _id: id(3), name: "synthetic", carbs: 10 }]));
      expect(verifyAgainstSql(internal, now).food).toHaveLength(1);
      const options = JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true });
      const created = JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify({
        identifier: "aux-api3-sensor", created_at: new Date(now - 9 * day).toISOString(),
        date: now - 9 * day, eventType: "Sensor Change", app: "synthetic", utcOffset: 0,
      }), options));
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
      expect(verifyAgainstSql(internal, now).treatments.some(row => row.identifier === "aux-api3-sensor")).toBe(true);
      await instance.api3DeleteDocument("treatments", "aux-api3-sensor", true, null);
      expect(verifyAgainstSql(internal, now).treatments.some(row => row._id === id(1))).toBe(true);
      await instance.deleteDocuments("treatments", [id(1)]);
      expect(verifyAgainstSql(internal, now).treatments).toHaveLength(0);
      await instance.deleteDocuments("food", [id(3)]);
      expect(verifyAgainstSql(internal, now).food).toHaveLength(0);

      // Legacy event callback runs before the data callback. Exercise failure
      // after either can populate a cache with uncommitted rows.
      for (const callback of ["realtime", "data"] as const) {
        const before = state.storage.sql.exec("SELECT collection,id,body FROM documents ORDER BY collection,id").toArray();
        const original = callback === "realtime"
          ? internal.realtime.recordApi3StorageMutationInTransaction
          : internal.recordDataMutationInTransaction;
        const fail = () => { internal.realtimeSnapshot(now, false, "ddata"); throw new Error("synthetic auxiliary rollback"); };
        if (callback === "realtime") internal.realtime.recordApi3StorageMutationInTransaction = fail;
        else internal.recordDataMutationInTransaction = fail;
        try {
          await expect(instance.createDocuments("profile", JSON.stringify([{
            _id: id(4), startDate: new Date(now).toISOString(),
            defaultProfile: "rolled-back", store: { "rolled-back": {} },
          }]))).rejects.toThrow("synthetic auxiliary rollback");
        } finally {
          if (callback === "realtime") internal.realtime.recordApi3StorageMutationInTransaction = original;
          else internal.recordDataMutationInTransaction = original as (collection: string) => void;
        }
        expect(state.storage.sql.exec("SELECT collection,id,body FROM documents ORDER BY collection,id").toArray()).toEqual(before);
        expect(verifyAgainstSql(internal, now).profiles[0]?.defaultProfile).toBe("updated");
      }
      return verifyAgainstSql(internal, now);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: EntryStore) => {
      const after = (instance as unknown as Internals).realtimeSnapshot(now, false, "ddata");
      expect(after.treatments).toEqual(finalSnapshot.treatments);
      expect(after.profiles).toEqual(finalSnapshot.profiles);
      expect(after.food).toEqual(finalSnapshot.food);
    });
  });

  it("refills budget-stopped prefixes and the ascending recent-mutation limit", async () => {
    const stub = env.ENTRY_STORE.getByName(`trio-aux-bounds-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const internal = instance as unknown as Internals;
      const now = Date.now();
      const repository = new SqliteDocumentRepository(state.storage);
      for (let index = 1; index <= 101; index++) {
        repository.createLegacyDocument("treatments", treatment(index, now - index * 1_000));
        state.storage.sql.exec("UPDATE documents SET updated_at = ? WHERE collection = 'treatments' AND id = ?", now + index, id(index));
      }
      for (const cache of Object.values(internal.realtimeAuxiliaryQueries)) cache.clear();
      internal.recentTreatmentQueries.clear();
      const query = "SELECT id,body,sort_time,updated_at FROM documents WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC LIMIT 1000";
      // realtimeDocuments breaks its source iterator when shared output budget
      // is exhausted. Reproduce that exact stop at this cache boundary.
      for (const row of internal.cachedAuxiliaryRows(query, [now - day])) {
        expect(row.id).toBe(id(1));
        break;
      }
      const exec = vi.spyOn(state.storage.sql, "exec");
      try {
        expect([...internal.cachedAuxiliaryRows(query, [now - day])]).toHaveLength(101);
        expect(exec).toHaveBeenCalledOnce();
        expect([...internal.cachedAuxiliaryRows(query, [now - day])]).toHaveLength(101);
        expect(exec).toHaveBeenCalledOnce();
      } finally { exec.mockRestore(); }
      const recent = "SELECT id,body,sort_time,updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100";
      expect([...internal.cachedAuxiliaryRows(recent, [now])].at(-1)?.id).toBe(id(100));
      const advanced = [...internal.cachedAuxiliaryRows(recent, [now + 2])];
      expect(advanced).toHaveLength(100);
      expect(advanced.at(-1)?.id).toBe(id(101));
    });
  });

  it("activates future profile switches, expires old switches, and invalidates rollback and delete", async () => {
    const stub = env.ENTRY_STORE.getByName(`trio-aux-profile-switch-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internals;
      const now = Date.now();
      const switchAt = now + 60_000;
      const profileSwitch = (value: number, at: number, profile: string) => ({
        ...treatment(value, at, "Profile Switch"), duration: 0, profile,
      });
      await instance.createDocuments("treatments", JSON.stringify([
        profileSwitch(1, now - day, "current"), profileSwitch(2, switchAt, "future"),
      ]));
      const verify = (at: number, expected: string | null) => {
        expect(internal.activeProfileFromSwitch(at)).toBe(expected);
        const committed = internal.activeProfileSwitchCache;
        internal.activeProfileSwitchCache = undefined;
        try { expect(internal.activeProfileFromSwitch(at)).toBe(expected); }
        finally { internal.activeProfileSwitchCache = committed; }
      };
      verify(now, "current");
      verify(switchAt - 1, "current");
      verify(switchAt, "future");
      verify(now, "current");
      verify(switchAt + 372 * day, "future");
      verify(switchAt + 372 * day + 1, null);
      await instance.deleteDocuments("treatments", [id(2)]);
      verify(switchAt, "current");
      const before = state.storage.sql.exec("SELECT id,body FROM documents WHERE collection='treatments' ORDER BY id").toArray();
      const original = internal.recordDataMutationInTransaction;
      let uncommitted: string | null = null;
      internal.recordDataMutationInTransaction = () => {
        uncommitted = internal.activeProfileFromSwitch(now);
        throw new Error("synthetic switch rollback");
      };
      try {
        await expect(instance.createDocuments("treatments", JSON.stringify([
          profileSwitch(3, now, "rolled-back"),
        ]))).rejects.toThrow("Treatment storage failure");
      } finally { internal.recordDataMutationInTransaction = original; }
      expect(uncommitted).toBe("rolled-back");
      expect(state.storage.sql.exec("SELECT id,body FROM documents WHERE collection='treatments' ORDER BY id").toArray()).toEqual(before);
      verify(now, "current");
    });
  });
});
