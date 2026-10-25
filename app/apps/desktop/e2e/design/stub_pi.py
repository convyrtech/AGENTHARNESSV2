"""Stub of the pi CLI (`pi --mode json …`) for recording a real run.py event log.

Each call pops the next scripted reply from $PI_CODING_AGENT_DIR/stub-script.json and prints it as pi JSON events:
one assistant message per entry of "turns" (tool calls and/or text), each as a `message_end` event. A reply may
write files first ("write": {relative path: "png" | text}) so the owner message can point at a real picture.
"""
import json, os, struct, sys, zlib
from pathlib import Path


def png(path, w=480, h=300, rgb=(196, 98, 45)):
    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        band = (y * 3) // h
        for x in range(w):
            col = (x * 3) // w
            k = (band + col) % 3
            raw += bytes([max(0, rgb[0] - 40 * k), max(0, rgb[1] + 30 * k), min(255, rgb[2] + 50 * k)])
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(data)


def main():
    # pi (node) writes UTF-8; Python on Windows would write the ANSI code page into run.py's pipe
    sys.stdout.reconfigure(encoding="utf-8")
    script = Path(os.environ["PI_CODING_AGENT_DIR"]) / "stub-script.json"
    replies = json.loads(script.read_text(encoding="utf-8"))
    reply = replies.pop(0) if replies else {"turns": [{"text": "ЭТАП ГОТОВ"}]}
    script.write_text(json.dumps(replies, ensure_ascii=False, indent=1), encoding="utf-8")
    for rel, body in (reply.get("write") or {}).items():
        if body == "png":
            png(rel)
        else:
            Path(rel).parent.mkdir(parents=True, exist_ok=True)
            Path(rel).write_text(body, encoding="utf-8")
    for turn in reply["turns"]:
        content = []
        for call in turn.get("tools", []):
            content.append({"type": "toolCall", "id": f"c{len(content)}", "name": call[0], "arguments": call[1]})
        if turn.get("text"):
            content.append({"type": "text", "text": turn["text"]})
        msg = {"role": "assistant", "content": content,
               "usage": {"input": 4200, "output": 380, "cacheRead": 3100, "cost": {"total": 0.0021}}}
        print(json.dumps({"type": "message_end", "message": msg}, ensure_ascii=False), flush=True)
    print(json.dumps({"type": "agent_end"}), flush=True)


if __name__ == "__main__":
    sys.exit(main())
