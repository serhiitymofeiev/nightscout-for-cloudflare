import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decodeEngineIoV3PollingPayload, decodeEngineIoV4PollingPayload } from "../src/protocol";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

function measure<T>(storage: DurableObjectStorage, action: () => T) {
  const exec = storage.sql.exec.bind(storage.sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = exec(sql, ...bindings);
    cursors.push(cursor);
    return cursor;
  });
  try {
    const value = action();
    return {
      value,
      reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    };
  } finally {
    spy.mockRestore();
  }
}

describe("realtime queue read amplification", () => {
  for (const engineProtocol of [3, 4] as const) {
    it(`dequeues EIO${engineProtocol} packets once while retaining FIFO, counters, and rollback`, async () => {
      const stub = env.ENTRY_STORE.getByName(`realtime-dequeue-read-budget-${crypto.randomUUID()}`);
      const report = await runInDurableObject(stub, async (_instance, state) => {
        const repository = new SqliteRealtimeSessionRepository(state.storage);
        const session = repository.createSession(Date.now(), "polling", engineProtocol);
        const frames = ["4first", "4second", "4😊"];
        repository.enqueueFrames(session.sid, frames, Date.now());
        const before = measure(state.storage, () => state.storage.transactionSync(() => {
          // The former polling path read the payload protocol, peeked the
          // frames, then performed a separate durable post-send acknowledgement.
          repository.requireSession(session.sid);
          const batch = repository.peekFrames(session.sid)!;
          repository.acknowledgeFrames(session.sid, batch);
          return batch.frames;
        }));
        repository.enqueueFrames(session.sid, frames, Date.now());
        const after = measure(state.storage, () => state.storage.transactionSync(() => repository.dequeuePayload(session.sid)));
        const packets = engineProtocol === 3
          ? decodeEngineIoV3PollingPayload(after.value!)
          : decodeEngineIoV4PollingPayload(after.value!);
        expect(packets).toEqual([
          { type: "message", data: "first" },
          { type: "message", data: "second" },
          { type: "message", data: "😊" },
        ]);
        expect(before.value).toEqual(frames);
        expect(after.reads).toBeLessThan(before.reads);
        expect(after.writes).toBe(before.writes);
        expect(repository.requireSession(session.sid)).toMatchObject({ outboundPackets: 0, outboundBytes: 0 });

        repository.enqueueFrames(session.sid, frames, Date.now());
        expect(repository.dequeueFrames(session.sid, 3, 6)).toEqual(["4first"]);
        expect(repository.requireSession(session.sid)).toMatchObject({ outboundPackets: 2, outboundBytes: 12 });
        state.storage.sql.exec(`CREATE TRIGGER fail_queue_counter_update BEFORE UPDATE ON realtime_sessions
          BEGIN SELECT RAISE(ABORT, 'test queue update failure'); END`);
        expect(() => state.storage.transactionSync(() => repository.dequeuePayload(session.sid))).toThrow("test queue update failure");
        state.storage.sql.exec("DROP TRIGGER fail_queue_counter_update");
        expect(new SqliteRealtimeSessionRepository(state.storage).dequeueFrames(session.sid)).toEqual(frames.slice(1));
        expect(repository.requireSession(session.sid)).toMatchObject({ outboundPackets: 0, outboundBytes: 0 });
        return { engineProtocol, before, after };
      });
      console.log(JSON.stringify({ label: "synchronous-dequeue-read-budget", ...report }));
    });
  }
});
