import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const line of fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/)){
 const pos=line.indexOf('=');if(pos<1||line.trim().startsWith('#'))continue;
 const key=line.slice(0,pos).trim();if(!process.env[key])process.env[key]=line.slice(pos+1).trim();
}
const bin=process.env.GOON_SQLITE_BIN,db=process.env.GOON_DB_FILE;
if(!bin||!db){console.error('SQLite backup requires GOON_SQLITE_BIN and GOON_DB_FILE');process.exit(2);}
const dbPath=path.resolve(root,db),destDir=path.resolve(root,process.env.GOON_BACKUP_DIR||'data/backups');
fs.mkdirSync(destDir,{recursive:true});
const dest=path.join(destDir,'goon-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite3');
const run=(args)=>spawnSync(bin,args,{cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
const result=run([dbPath,'.backup '+JSON.stringify(dest)]);
if(result.status!==0){console.error('SQLite backup failed; details suppressed');process.exit(1);}
const check=run([dest,'PRAGMA integrity_check;']);
if(check.status!==0||check.stdout.trim()!=='ok'){
 fs.rmSync(dest,{force:true});console.error('Backup integrity check failed');process.exit(1);
}
console.log(JSON.stringify({ok:true,backupPath:dest,bytes:fs.statSync(dest).size,integrity:'ok'}));
