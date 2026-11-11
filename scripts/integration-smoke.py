"""Offline integration smoke test. Uses a disposable SQLite database and synthetic evidence only."""
from __future__ import annotations
import json, os, pathlib, sqlite3, subprocess, tempfile, time, urllib.error, urllib.parse, urllib.request
from contextlib import closing

ROOT=pathlib.Path(__file__).resolve().parents[1]
APP="Fixtures-opc-fixture"
A="goon-fixture-a-32-characters-aaaaaaaa"
B="goon-fixture-b-32-characters-bbbbbbbb"
RATINGS={"demand":4,"growth":4,"payment":4,"competition":4,"feasibility":4}

def request(path,body=None,token=None):
    headers={"Content-Type":"application/json"}
    if token: headers["Authorization"]="Bearer "+token
    payload=json.dumps(body).encode("utf-8") if body is not None else None
    req=urllib.request.Request("http://127.0.0.1:4193"+path,data=payload,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=20) as response:
            return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        return error.code,json.loads(error.read().decode("utf-8"))

def main():
    with tempfile.TemporaryDirectory(prefix="goon-smoke-") as dirname:
        db=pathlib.Path(dirname)/"fixture.sqlite3"
        con=sqlite3.connect(db)
        con.execute("CREATE TABLE snapshots(date TEXT NOT NULL,source TEXT NOT NULL,items_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(date,source))")
        for day in range(1,8):
            item={"id":"opc-fixture","name":"Goon synthetic test product","rank":11-day,
              "description":"A synthetic test product for verifying opportunity scoring only.",
              "developer":"Fixture developer","launchDate":"2026-11-01","ratingCount":10,
              "rating":4.2,"url":"https://example.com/fixture","platform":"Android",
              "country":"美国","category":"测试","fieldSources":{"rating":"fixture"}}
            con.execute("INSERT INTO snapshots(date,source,items_json) VALUES (?,?,?)",
                (f"2026-11-{day+3:02d}","Fixtures",json.dumps([item])))
        con.commit();con.close()
        env=dict(os.environ,GOON_DB_FILE=str(db),GOON_PORT="4193",GOON_REVIEWER_A_TOKEN=A,GOON_REVIEWER_B_TOKEN=B)
        proc=subprocess.Popen(["node","server.mjs"],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            for attempt in range(30):
                try:
                    if request("/api/apps")[0]==200: break
                except (urllib.error.URLError,TimeoutError): time.sleep(0.2)
            else: raise RuntimeError("server did not start")
            path="/api/opportunities/"+urllib.parse.quote(APP,safe="")
            assert request(path)[0]==401
            assert request("/api/sync/all",{})[0]==401
            assert request('/api/candidates')[0]==401
            s,candidate_data=request('/api/candidates',{'appId':APP,'status':'assigned','assignedTo':'reviewer_b','note':'Synthetic candidate assigned for test only.'},A)
            assert s==200,(s,candidate_data)
            s,candidate_data=request('/api/candidates',token=B)
            assert s==200 and any(x['app_id']==APP and x['assigned_to']=='reviewer_b' for x in candidate_data['items'])
            status,data=request(path,token=A);assert status==200 and data["opportunity"]["score"] is None
            for idx,(kind,domain) in enumerate([
                ("community","example.org"),
                ("pricing","example.net"),
                ("competitor","example.com"),
            ]):
                item={"action":"evidence","type":kind,
                  "sourceUrl":f"https://{domain}/source/{idx}",
                  "quote":"This is synthetic documentation evidence for local testing only",
                  "context":"Simulated cross verification in a temporary database"}
                status,data=request(path,item,A);assert status==200,(status,data)
                evidence_id=data["evidence"][0]["id"]
                assert request(path,{"action":"verify","evidenceId":evidence_id,"status":"verified"},A)[0]==403
                assert request(path,{"action":"verify","evidenceId":evidence_id,"status":"verified"},B)[0]==200
            for token in [A,B]:
                status,data=request(path,{"action":"review","verdict":"approve",
                  "note":"Synthetic evaluation for integration tests only.",
                  "ratings":RATINGS},token)
                assert status==200,(status,data)
            assert data["opportunity"]["score"]==80,data["opportunity"]
            assert data["opportunity"]["decision"]=="通过（需业务验证）"
            assert len(data["opportunity"]["assessmentData"])==2
            assert len(data["audit"])==9
            assert request(path,{"action":"review","verdict":"reject",
              "note":"This duplicate must be rejected.","ratings":RATINGS},A)[0]==409
            # V0.2.1: shared import, duplicate import, noise and restart persistence.
            payload={"items":[{"name":"Synthetic imported app","description":"Test fixture only","platform":"Web","url":"https://example.com/imported"}]}
            assert request('/api/import',payload)[0]==401
            assert request('/api/import',payload,A)[0]==200
            assert request('/api/import',payload,B)[0]==200
            items=request('/api/apps?window=7')[1]['apps']
            imported=[x for x in items if x['source']=='手动导入']
            assert len(imported)==1, imported
            imported_id=imported[0]['id']
            assert request('/api/flags',{'appId':imported_id,'noise':True})[0]==401
            assert request('/api/flags',{'appId':imported_id,'noise':True},A)[0]==200
            assert next(x for x in request('/api/apps')[1]['apps'] if x['id']==imported_id)['noise'] is True
            proc.terminate();proc.wait(timeout=10)
            proc=subprocess.Popen(["node","server.mjs"],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            for attempt in range(40):
                try:
                    if request("/api/apps")[0]==200: break
                except (urllib.error.URLError,TimeoutError): time.sleep(0.2)
            else: raise RuntimeError("server did not restart")
            items=request('/api/apps')[1]['apps']
            assert len([x for x in items if x['id']==imported_id])==1
            assert next(x for x in items if x['id']==imported_id)['noise'] is True
            assert request('/api/flags',{'appId':imported_id,'noise':False},B)[0]==200
            assert not next(x for x in request('/api/apps')[1]['apps'] if x['id']==imported_id).get('noise')
            with closing(sqlite3.connect(db)) as con:
                assert con.execute("SELECT count(*) FROM snapshots").fetchone()[0]==7
                assert con.execute("SELECT count(*) FROM imported_apps").fetchone()[0]==1
                assert con.execute("PRAGMA integrity_check").fetchone()[0]=='ok'
            print(json.dumps({"import_dedup":True,"noise_persistence":True,"restart_persistence":True,"original_snapshots_preserved":7,"sqlite_integrity":"ok"},ensure_ascii=False))
            print(json.dumps({"passed":True,"verified_sources":3,"independent_reviewers":2,
              "human_score":80,"decision":data["opportunity"]["decision"],"shared_assignment":True,"audit_entries":len(data["audit"]),
              "production_data_touched":False},ensure_ascii=False))
        finally:
            proc.terminate()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:proc.kill()

if __name__=="__main__":main()
