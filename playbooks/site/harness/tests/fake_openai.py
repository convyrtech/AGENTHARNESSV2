"""Fake OpenAI-compatible chat completions for tests that run the real Pi: each request is answered with the next
reply of a script (JSON lines: {"tool": name, "args": {...}} or {"text": "..."}), every request is logged.

  python fake_openai.py <script.jsonl> <requests.log>    prints the port, serves until killed
"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
SCRIPT = [json.loads(x) for x in open(sys.argv[1], encoding="utf-8") if x.strip()]
LOG = sys.argv[2]
state = {"n": 0}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"data": [{"id": "m"}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); req = json.loads(self.rfile.read(n))
        with open(LOG, "a", encoding="utf-8") as f: f.write(json.dumps(req, ensure_ascii=False) + "\n")
        rep = SCRIPT[min(state["n"], len(SCRIPT) - 1)]; state["n"] += 1
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        def chunk(delta, finish=None):
            d = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(d, ensure_ascii=False)}\n\n".encode())
        if "tool" in rep:
            chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": f"call{state['n']}", "type": "function",
                   "function": {"name": rep["tool"], "arguments": json.dumps(rep["args"], ensure_ascii=False)}}]})
            chunk({}, "tool_calls")
        else:
            chunk({"role": "assistant", "content": rep["text"]}); chunk({}, "stop")
        u = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m", "choices": [],
             "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        self.wfile.write(f"data: {json.dumps(u)}\n\ndata: [DONE]\n\n".encode())

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
