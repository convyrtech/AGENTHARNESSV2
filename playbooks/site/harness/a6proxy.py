"""Прокси надёжности перед шлюзом a6 (OpenAI-совместимый /v1/chat/completions), только стандартная библиотека.

Зачем (E8, 23–24.10.2026): поставщики a6 иногда молчат минутами или отдают ошибку внутри потока, и ход агента
обрывается пустым сообщением (Pi не повторяет такие ошибки). Плюс ключ a6 не должен попадать к агенту.

Что делает:
  - держит ключ сам: в конфиге Pi стоит адрес прокси и ключ-заглушка;
  - ждёт первый полезный кусок ответа не дольше --ttft секунд, иначе рвёт и повторяет (a6 при повторе выбирает
    поставщика заново); повторяет и на 429/5xx, на ошибку a6 в теле или в первом событии потока, на пустой ответ;
  - после первого полезного куска отдаёт поток агенту без задержки; молчание дольше --idle посреди потока — ошибка;
  - пишет строку метрик на каждый вызов в --log (JSONL): модель, попытки, время до первого токена, всего,
    prompt/cached/completion/reasoning токены — для замеров (research/16 §6.8).

Запуск:  a6proxy.py --port 8787 --key-file experiments/.a6key --log logs/a6proxy.jsonl
Pi:      провайдер с baseUrl http://127.0.0.1:8787/v1 и apiKey "local".
"""
import argparse, http.client, http.server, json, os, socket, ssl, sys, threading, time, urllib.parse

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8787)
ap.add_argument("--key-file", required=True)
ap.add_argument("--upstream", default="https://a6api.com")
ap.add_argument("--ttft", type=float, default=150.0, help="секунд до первого полезного куска")
ap.add_argument("--idle", type=float, default=180.0, help="секунд тишины посреди потока")
ap.add_argument("--attempts", type=int, default=3)
ap.add_argument("--log", default="a6proxy.jsonl")
a = ap.parse_args()

KEY = open(a.key_file).read().strip()
UP = urllib.parse.urlparse(a.upstream)
PROXY = urllib.parse.urlparse(os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "")
CTX = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
LOCK = threading.Lock()
# ошибки a6 приходят текстом в теле или в первом событии потока (E8q: «等待响应超时 … 上游服务 …»)
RETRY_TEXT = ("等待响应超时", "上游", "upstream", "timeout", "timed out", "overloaded", "temporarily", "no available",
              "rate limit", "try again", "稍后重试")


def log(rec):
    rec["ts"] = round(time.time(), 3)
    with LOCK, open(a.log, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def connect(timeout):
    if PROXY.hostname:
        c = http.client.HTTPSConnection(PROXY.hostname, PROXY.port or 80, context=CTX, timeout=timeout)
        c.set_tunnel(UP.hostname, UP.port or 443)
    else:
        c = http.client.HTTPSConnection(UP.hostname, UP.port or 443, context=CTX, timeout=timeout)
    return c


def looks_like_error(text):
    t = text.lower()
    return '"error"' in t and any(k.lower() in t for k in RETRY_TEXT) or any(k in text for k in ("等待响应超时", "上游服务"))


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):                                   # /v1/models и прочее — как есть
        c = connect(60)
        c.request("GET", self.path, headers={"Authorization": "Bearer " + KEY})
        r = c.getresponse()
        self._send(r.status, r.read(), r.getheader("Content-Type") or "application/json")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            req = json.loads(body)
        except ValueError:
            return self._send(400, '{"error":"bad json"}')
        stream = bool(req.get("stream"))
        if stream:
            req.setdefault("stream_options", {})["include_usage"] = True
        payload = json.dumps(req).encode()
        rec = {"model": req.get("model"), "stream": stream, "attempts": [], "path": self.path}
        t_all = time.time()
        for n in range(1, a.attempts + 1):
            t0 = time.time()
            att = {"n": n}
            rec["attempts"].append(att)
            try:
                c = connect(a.ttft)
                c.request("POST", self.path, body=payload, headers={"Authorization": "Bearer " + KEY,
                                                                     "Content-Type": "application/json"})
                r = c.getresponse()
                att["status"] = r.status
                if r.status in (429, 500, 502, 503, 504, 520, 522, 524):
                    att["err"] = r.read()[:300].decode("utf-8", "replace")
                    time.sleep(min(8, 2 ** n))
                    continue
                if r.status != 200:
                    data = r.read()
                    rec.update(status=r.status, total_s=round(time.time() - t_all, 2))
                    log(rec)
                    return self._send(r.status, data, r.getheader("Content-Type") or "application/json")
                if not stream:
                    data = r.read()
                    txt = data.decode("utf-8", "replace")
                    if looks_like_error(txt):
                        att["err"] = txt[:300]; continue
                    try:
                        j = json.loads(txt)
                        msg = (j.get("choices") or [{}])[0].get("message") or {}
                        if not (msg.get("content") or msg.get("tool_calls")):
                            att["err"] = "empty"; continue
                        self._usage(rec, j.get("usage") or {})
                    except ValueError:
                        pass
                    rec.update(status=200, ttft_s=round(time.time() - t0, 2), total_s=round(time.time() - t_all, 2))
                    log(rec)
                    return self._send(200, data)
                # поток: ждём первое полезное событие не дольше ttft
                pending, first = [], None
                while True:
                    if time.time() - t0 > a.ttft:          # пинги «: keep-alive» не продлевают ожидание первого токена
                        att["err"] = "ttft deadline"; break
                    line = r.fp.readline()
                    if not line:
                        break
                    pending.append(line)
                    s = line.decode("utf-8", "replace").strip()
                    if not s.startswith("data:"):
                        continue
                    d = s[5:].strip()
                    if d == "[DONE]":
                        break
                    if looks_like_error(d):
                        first = "error"; att["err"] = d[:300]; break
                    try:
                        ch = (json.loads(d).get("choices") or [{}])[0].get("delta") or {}
                    except ValueError:
                        continue
                    if ch.get("content") or ch.get("tool_calls") or ch.get("reasoning_content") or ch.get("reasoning"):
                        first = "ok"; break
                if first != "ok":
                    att.setdefault("err", "empty stream")
                    try:
                        c.close()
                    except Exception:
                        pass
                    continue
                att["ttft_s"] = rec["ttft_s"] = round(time.time() - t0, 2)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for ln in pending:
                    self._chunk(ln)
                done_early = any(x.strip() == b"data: [DONE]" for x in pending)
                try:
                    c.sock.settimeout(a.idle)
                except Exception:
                    pass
                try:
                    while not done_early:
                        line = r.fp.readline()
                        if not line:
                            break
                        self._chunk(line)
                        s = line.decode("utf-8", "replace").strip()
                        if s == "data: [DONE]":           # поставщик держит соединение после конца — не ждём
                            break
                        if s.startswith("data:") and '"usage"' in s:
                            try:
                                u = json.loads(s[5:]).get("usage")
                                if u:
                                    self._usage(rec, u)
                            except ValueError:
                                pass
                    rec["status"] = 200
                except (socket.timeout, TimeoutError) as e:
                    rec["status"] = "idle-timeout"; rec["err"] = repr(e)[:120]
                    self._chunk(b'data: {"error":{"message":"a6proxy: stream stalled"}}\n\n')
                self.wfile.write(b"0\r\n\r\n")
                try:
                    c.close()
                except Exception:
                    pass
                rec["total_s"] = round(time.time() - t_all, 2)
                log(rec)
                return
            except (socket.timeout, TimeoutError, ConnectionError, http.client.HTTPException, OSError) as e:
                att["err"] = repr(e)[:200]
                continue
        rec.update(status="failed", total_s=round(time.time() - t_all, 2))
        log(rec)
        self._send(502, json.dumps({"error": {"message": "a6proxy: all attempts failed", "attempts": rec["attempts"]}},
                                   ensure_ascii=False))

    def _chunk(self, b):
        self.wfile.write(f"{len(b):x}\r\n".encode() + b + b"\r\n")
        self.wfile.flush()

    @staticmethod
    def _usage(rec, u):
        d = u.get("prompt_tokens_details") or {}
        cd = u.get("completion_tokens_details") or {}
        rec.update(prompt=u.get("prompt_tokens"), cached=d.get("cached_tokens") or u.get("prompt_cache_hit_tokens") or u.get("cache_read_input_tokens"),
                   completion=u.get("completion_tokens"), reasoning=cd.get("reasoning_tokens"))


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    srv = Server(("127.0.0.1", a.port), H)
    print(f"a6proxy on 127.0.0.1:{a.port} → {a.upstream} (ttft {a.ttft}s, idle {a.idle}s, attempts {a.attempts})", flush=True)
    srv.serve_forever()
