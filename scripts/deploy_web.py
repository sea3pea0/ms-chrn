"""Point the Ingest web-app deployment at the current code (run after push_gas.py when gas/Ingest.gs changes)."""
import sys
sys.path.insert(0, "scripts")
import push_gas
from googleapiclient.discovery import build
svc = build("script", "v1", credentials=push_gas.get_credentials())
sid = push_gas.load_env_script_id()
deps = svc.projects().deployments().list(scriptId=sid).execute().get("deployments", [])
web = [d for d in deps if d.get("deploymentConfig", {}).get("versionNumber") and any(e.get("entryPointType") == "WEB_APP" for e in d.get("entryPoints", []))]
v = svc.projects().versions().create(scriptId=sid, body={"description": "Ingest endpoint"}).execute()["versionNumber"]
cfg = {"versionNumber": v, "manifestFileName": "appsscript", "description": "MS-CHRN ingest"}
if web:
    d = svc.projects().deployments().update(scriptId=sid, deploymentId=web[0]["deploymentId"], body={"deploymentConfig": cfg}).execute()
else:
    d = svc.projects().deployments().create(scriptId=sid, body=cfg).execute()
for e in d.get("entryPoints", []):
    if e.get("entryPointType") == "WEB_APP": print("URL", e["webApp"]["url"], "version", v)
