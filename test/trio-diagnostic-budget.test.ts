import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { it, expect, vi } from 'vitest';
import type { EntryStore } from '../src/entry-store';
import { SqliteDocumentRepository } from '../src/document-repository';
it('measures identical sensor records and status backfill', async () => {
 const result=await runInDurableObject(env.ENTRY_STORE.getByName(`trio-diag-${crypto.randomUUID()}`),async(instance:EntryStore,state)=>{
 const sql=state.storage.sql,repo=new SqliteDocumentRepository(state.storage),now=Date.now();
 for(let i=0;i<576;i++)repo.createLegacyDocument('devicestatus',{created_at:new Date(now-i*300000).toISOString(),device:'synthetic-trio',openaps:{suggested:{timestamp:new Date(now-i*300000).toISOString()}}});
 const sensor={eventType:'Sensor Change',created_at:new Date(now-86400000).toISOString(),enteredBy:'Trio',notes:'synthetic sensor'};
 const exec=sql.exec.bind(sql);let cursors:{q:string,c:any}[]=[];const rows:any[]=[];
 const spy=vi.spyOn(sql,'exec').mockImplementation((q,...b)=>{const c=exec(q,...b);cursors.push({q,c});return c;});
 async function measure(label:string,fn:()=>unknown){cursors=[];await fn();const groups:Record<string,any>={};for(const {q,c}of cursors){const key=q.replace(/\s+/g,' ').trim();const g=groups[key]??={calls:0,read:0,written:0};g.calls++;g.read+=c.rowsRead;g.written+=c.rowsWritten;}rows.push({label,read:cursors.reduce((a,x)=>a+x.c.rowsRead,0),written:cursors.reduce((a,x)=>a+x.c.rowsWritten,0),groups});}
 try{
 await measure('sensor-first-repository',()=>repo.createLegacyTreatmentBundle(sensor));
 await measure('sensor-identical-repository',()=>repo.createLegacyTreatmentBundle(sensor));
 await measure('sensor-identical-full-store',()=>instance.createLegacyTreatments(JSON.stringify([sensor])));
 await measure('sensor-identical-full-store-10',async()=>{for(let i=0;i<10;i++)await instance.createLegacyTreatments(JSON.stringify([sensor]));});
 await measure('status-backfill-163',async()=>{for(let i=0;i<163;i++)await instance.createDocuments('devicestatus',JSON.stringify([{created_at:new Date(now+1000+i).toISOString(),device:'synthetic-trio',openaps:{suggested:{timestamp:new Date(now-i*300000).toISOString()}}}]));});
 }finally{spy.mockRestore();}
 const sensorCount=sql.exec("SELECT COUNT(*) n FROM documents WHERE collection='treatments'").one();const ledgerCount=sql.exec("SELECT COUNT(*) n FROM document_changes WHERE collection='treatments'").one();expect(sensorCount.n).toBe(1);expect(ledgerCount.n).toBe(13);return{rows,sensorCount,ledgerCount};
 });console.log('TRIO_DIAGNOSTIC_SQL',JSON.stringify(result));
},60000);
