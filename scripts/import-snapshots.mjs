import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const inputFile=process.argv[2];
const sqliteBin=process.env.GOON_SQLITE_BIN;
const databaseFile=process.env.GOON_DB_FILE;
if(!inputFile||!sqliteBin||!databaseFile){
  console.error('用法：设置 GOON_SQLITE_BIN、GOON_DB_FILE，并传入快照 JSON 文件。');
  process.exit(1);
}

const quote=value=>`'${String(value).replace(/'/g,"''")}'`;
const snapshots=JSON.parse(await fs.readFile(inputFile,'utf8'));
if(!Array.isArray(snapshots)||snapshots.some(x=>!x?.date||!x?.source||!Array.isArray(x?.items))){
  throw new Error('快照文件结构无效。');
}

const statements=snapshots.map(snapshot=>`INSERT INTO snapshots(date,source,items_json) VALUES(${quote(snapshot.date)},${quote(snapshot.source)},${quote(JSON.stringify(snapshot.items))}) ON CONFLICT(date,source) DO UPDATE SET items_json=excluded.items_json,created_at=CURRENT_TIMESTAMP;`).join('\n');
const sql=`PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; ${statements} COMMIT;`;
await new Promise((resolve,reject)=>{
  const child=spawn(sqliteBin,[databaseFile],{stdio:['pipe','pipe','pipe']});
  const stderr=[];
  child.stderr.on('data',chunk=>stderr.push(chunk));
  child.on('error',reject);
  child.on('close',code=>code===0?resolve():reject(new Error(Buffer.concat(stderr).toString('utf8')||`SQLite 退出码 ${code}`)));
  child.stdin.end(sql,'utf8');
});
console.log(JSON.stringify({imported:snapshots.length,dates:[...new Set(snapshots.map(x=>x.date))],sources:[...new Set(snapshots.map(x=>x.source))]}));
