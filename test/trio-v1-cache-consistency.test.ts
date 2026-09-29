import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { EntryStore } from '../src/entry-store';
import type { DeviceStatusQueryCache, CachedDeviceStatusRow } from '../src/realtime/device-status-query-cache';
it('preserves v1 snapshots, per-record commits, rollback, and eviction', async () => {
 const stub=env.ENTRY_STORE.getByName(`trio-v1-consistency-${crypto.randomUUID()}`);
 const now=Date.now();
 await runInDurableObject(stub,async(instance:EntryStore,state)=>{
  const internal=instance as unknown as {
   realtimeSnapshot(at:number,frame:boolean,mode:string): {devicestatus:unknown[]};
   realtimeDeviceStatusQueries:DeviceStatusQueryCache<CachedDeviceStatusRow>;
   realtime:{recordApi3StorageMutationInTransaction(event:unknown):void};
  };
  const row=(id:string,at:number)=>({_id:id,created_at:new Date(at).toISOString(),device:'synthetic-trio',openaps:{suggested:{timestamp:new Date(at).toISOString(),IOB:0,COB:0}}});
  const verify=()=>{
   for(const mode of ['root','ddata'])for(const at of [now,now-3600000,now+3600000]){
    const cached=internal.realtimeSnapshot(at,false,mode);
    const committed=internal.realtimeDeviceStatusQueries;
    internal.realtimeDeviceStatusQueries=committed.fork();internal.realtimeDeviceStatusQueries.clear();
    try{expect(internal.realtimeSnapshot(at,false,mode)).toEqual(cached);}finally{internal.realtimeDeviceStatusQueries=committed;}
   }
  };
  internal.realtimeSnapshot(now,false,'ddata');
  for(const [id,at] of [['000000000000000000000001',now],['000000000000000000000002',now-300000],['000000000000000000000003',now-30*86400000],['000000000000000000000004',now+300000]] as const){
   await instance.createDocuments('devicestatus',JSON.stringify([row(id,at)]));verify();
  }
  // Equal sort and update timestamps deliberately invalidate, preserving SQL tie ordering.
  const time=vi.spyOn(Date,'now').mockReturnValue(now);
  try{await instance.createDocuments('devicestatus',JSON.stringify([row('000000000000000000000005',now),row('000000000000000000000006',now)]));}finally{time.mockRestore();}
  verify();
  const before=state.storage.sql.exec("SELECT id,body,revision FROM documents WHERE collection='devicestatus' ORDER BY id").toArray();
  const callback=internal.realtime.recordApi3StorageMutationInTransaction;
  internal.realtime.recordApi3StorageMutationInTransaction=()=>{internal.realtimeSnapshot(now,false,'ddata');throw new Error('synthetic rollback');};
  try{await expect(instance.createDocuments('devicestatus',JSON.stringify([row('000000000000000000000007',now+1000)]))).rejects.toThrow();}finally{internal.realtime.recordApi3StorageMutationInTransaction=callback;}
  expect(state.storage.sql.exec("SELECT id,body,revision FROM documents WHERE collection='devicestatus' ORDER BY id").toArray()).toEqual(before);verify();
  // Legacy batches commit each successful item: a later duplicate must not erase that item/cache.
  await expect(instance.createDocuments('devicestatus',JSON.stringify([row('000000000000000000000008',now+2000),row('000000000000000000000001',now)]))).rejects.toThrow();
  expect(state.storage.sql.exec("SELECT COUNT(*) n FROM documents WHERE collection='devicestatus'").one().n).toBe(7);verify();
 });
 await evictDurableObject(stub);
 await runInDurableObject(stub,(_instance,state)=>{expect(state.storage.sql.exec("SELECT COUNT(*) n FROM documents WHERE collection='devicestatus'").one().n).toBe(7);});
});
