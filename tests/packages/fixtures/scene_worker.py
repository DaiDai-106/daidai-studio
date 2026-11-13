import argparse
import json
import os
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--project-id", required=True)
parser.add_argument("--data-dir", required=True)
args = parser.parse_args()
with open(os.path.join(args.data_dir, "started"), "w", encoding="utf-8") as marker:
    marker.write(str(os.getpid()))

for line in sys.stdin:
    request = json.loads(line)
    if request["params"]["path"].endswith("hang.step"):
        time.sleep(30)
    if request["params"]["path"].endswith("slow.step"):
        time.sleep(0.4)
    if request["params"]["path"].endswith("large-response.step"):
        print(json.dumps({"id": request["id"], "ok": True, "result": {"payload": "x" * (2 * 1024 * 1024)}}), flush=True)
        continue
    if request["params"]["path"].endswith("oversized-response.step"):
        print(json.dumps({"id": request["id"], "ok": True, "result": {"payload": "界" * (3 * 1024 * 1024)}}, ensure_ascii=False), flush=True)
        continue
    if request["params"]["path"].endswith("invalid.step"):
        reply = {"id": request["id"], "ok": False, "error": {"code": "INVALID_STEP", "message": "invalid STEP"}}
    else:
        reply = {"id": request["id"], "ok": True, "result": {"pid": os.getpid(), "projectId": args.project_id, "path": request["params"]["path"]}}
    print(json.dumps(reply), flush=True)
