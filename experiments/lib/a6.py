"""Minimal a6api client for experiments. Logs every call (without the key) to exp/logs/."""
import json, os, time, urllib.request, urllib.error, itertools

BASE = "https://a6api.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGS = os.path.join(ROOT, "logs")
os.makedirs(LOGS, exist_ok=True)
_KEY = open(os.path.join(ROOT, ".a6key")).read().strip()
_seq = itertools.count()


def _log(tag, payload):
    name = f"{time.strftime('%H%M%S')}-{next(_seq):03d}-{tag}.json"
    with open(os.path.join(LOGS, name), "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    return name


def request(method, path, body=None, timeout=600):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + _KEY)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, headers, raw = r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, headers, raw = e.code, dict(e.headers), e.read().decode("utf-8", "replace")
    dt = round(time.time() - t0, 2)
    try:
        parsed = json.loads(raw)
    except ValueError:
        parsed = None
    return status, headers, parsed, raw, dt


def chat(body, tag="chat", timeout=600):
    """Non-streaming chat completion. Returns dict with status, json, raw, headers, secs, log file."""
    status, headers, parsed, raw, dt = request("POST", "/v1/chat/completions", body, timeout)
    log = _log(tag, {"request": body, "status": status, "secs": dt,
                     "headers": {k: v for k, v in headers.items() if k.lower() not in ("set-cookie",)},
                     "response": parsed if parsed is not None else raw[:20000]})
    return {"status": status, "json": parsed, "raw": raw, "headers": headers, "secs": dt, "log": log}


def chat_stream(body, tag="stream", timeout=600):
    """Streaming chat completion; returns list of decoded SSE chunks plus status."""
    body = dict(body, stream=True)
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + "/v1/chat/completions", data=data, method="POST")
    req.add_header("Authorization", "Bearer " + _KEY)
    req.add_header("Content-Type", "application/json")
    chunks, status, t0 = [], None, time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            for line in r:
                line = line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunks.append(json.loads(payload))
                except ValueError:
                    chunks.append({"_raw": payload})
    except urllib.error.HTTPError as e:
        status = e.code
        chunks.append({"_error": e.read().decode("utf-8", "replace")})
    dt = round(time.time() - t0, 2)
    log = _log(tag, {"request": body, "status": status, "secs": dt, "chunks": chunks})
    return {"status": status, "chunks": chunks, "secs": dt, "log": log}


def usage_cents():
    """Cumulative usage reported by the OpenAI-compatible billing endpoint (cents)."""
    _, _, parsed, _, _ = request("GET", "/v1/dashboard/billing/usage")
    return (parsed or {}).get("total_usage")
