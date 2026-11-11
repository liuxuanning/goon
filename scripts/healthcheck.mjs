import {setTimeout as sleep} from 'node:timers/promises';
const base=(process.env.GOON_HEALTH_URL||'http://127.0.0.1:4173').replace(/\/$/,'');
async function get(path){
 const res=await fetch(base+path,{signal:AbortSignal.timeout(15000)});
 if(!res.ok)throw new Error(path+' returned '+res.status);
 return res.json();
}
try{
 const a=await get('/api/apps?window=7');
 const s=await get('/api/snapshots');
 if(!Array.isArray(a.apps)||!Array.isArray(s))throw new Error('Unexpected response schema');
 const sources=[...new Set(a.apps.map(x=>x.source))];
 console.log(JSON.stringify({ok:true,apps:a.apps.length,snapshotBatches:s.length,sources,updatedAt:a.updatedAt}));
}catch(error){console.error('Health check failed:',error.message);process.exitCode=1;}
