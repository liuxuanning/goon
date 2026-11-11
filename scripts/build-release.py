"""Build a safe, allowlisted Goon release ZIP. Never bundle .env or database files."""
from __future__ import annotations
import hashlib, json, pathlib, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
FILES=[
"server.mjs","opportunity.mjs","package.json",
"public/index.html","public/app.js","public/opportunity-ui.js","public/styles.css",
"scripts/import-snapshots.mjs","scripts/backup-db.mjs","scripts/healthcheck.mjs",
"scripts/integration-smoke.py",
"scripts/run-daily.ps1","scripts/run-daily.sh",
"deploy/goon-app.service.template","deploy/goon-sync.service.template",
"deploy/goon-sync.timer.template","deploy/nginx-goon.conf.template",
"README.md","docs/DEPLOYMENT_RUNBOOK.md"
]
def main():
    missing=[name for name in FILES if not (ROOT/name).is_file()]
    if missing:raise SystemExit("Missing release files: "+", ".join(missing))
    dist=ROOT/"dist";dist.mkdir(exist_ok=True)
    output=dist/"goon-release.zip"
    digests={}
    with zipfile.ZipFile(output,"w",compression=zipfile.ZIP_DEFLATED) as z:
        for name in FILES:
            content=(ROOT/name).read_bytes()
            z.writestr(name,content)
            digests[name]=hashlib.sha256(content).hexdigest()
        z.writestr("MANIFEST.sha256.json",json.dumps(digests,indent=2))
    with zipfile.ZipFile(output) as z:
        entries=z.namelist()
        forbidden=[p for p in entries if ".env" in p or "sqlite" in p or p.startswith("data/") or "token" in p.lower()]
        assert not forbidden,forbidden
    print(json.dumps({"zip":str(output),"files":len(FILES),"bytes":output.stat().st_size,
      "secrets_bundled":False},ensure_ascii=False))
if __name__=="__main__":main()
