"""Mini benchmark: edit-tool format x cheap model. Harness verifies by running the original tests itself."""
import sys, os, json, time, tempfile, subprocess, threading, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import a6, tasks

SYSTEM = ("You are a coding agent working in a small Python workspace. Use the tools to read and modify files and to run "
          "the tests. Read a file before editing it. Do not modify test files (test_*.py). When the tests pass, reply with "
          "'DONE: <one-line summary>'. If you cannot finish, reply 'GIVE UP: <reason>'.")

def _obj(props, req):
    return {"type": "object", "properties": props, "required": req, "additionalProperties": False}
RUN = {"type": "function", "function": {"name": "run_tests", "description": "Run the test file of this task and return its output.", "parameters": _obj({}, [])}}
VARIANTS = {
 "flat": [
  {"type": "function", "function": {"name": "read_file", "description": "Read a file. Returns its content with line numbers (for reference only; line numbers are not part of the file).",
     "parameters": _obj({"file_path": {"type": "string"}}, ["file_path"])}},
  {"type": "function", "function": {"name": "edit_file", "description": "Replace an exact string in a file. old_string must match the file exactly (including indentation) and must be unique unless replace_all is true.",
     "parameters": _obj({"file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}, "replace_all": {"type": "boolean"}}, ["file_path", "old_string", "new_string"])}},
  {"type": "function", "function": {"name": "write_file", "description": "Create or overwrite a whole file.",
     "parameters": _obj({"file_path": {"type": "string"}, "content": {"type": "string"}}, ["file_path", "content"])}},
  RUN],
 "pi": [
  {"type": "function", "function": {"name": "read", "description": "Read a file. Returns its content with line numbers (for reference only).",
     "parameters": _obj({"path": {"type": "string"}}, ["path"])}},
  {"type": "function", "function": {"name": "edit", "description": "Apply one or more exact text replacements to a file. Each oldText must match the original file exactly and be unique.",
     "parameters": _obj({"path": {"type": "string"}, "edits": {"type": "array", "items": _obj({"oldText": {"type": "string"}, "newText": {"type": "string"}}, ["oldText", "newText"])}}, ["path", "edits"])}},
  {"type": "function", "function": {"name": "write", "description": "Create or overwrite a whole file.",
     "parameters": _obj({"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"])}},
  RUN],
 "editor": [
  {"type": "function", "function": {"name": "str_replace_editor", "description": "File editor. command=view shows a file with line numbers; command=create writes file_text to path; command=str_replace replaces old_str (exact, unique) with new_str; command=insert inserts new_str after line insert_line.",
     "parameters": _obj({"command": {"type": "string", "enum": ["view", "create", "str_replace", "insert"]}, "path": {"type": "string"},
                         "file_text": {"type": "string"}, "old_str": {"type": "string"}, "new_str": {"type": "string"}, "insert_line": {"type": "integer"}}, ["command", "path"])}},
  RUN],
}

def numbered(text):
    return "\n".join(f"{i+1:4}\t{l}" for i, l in enumerate(text.split("\n")))

def run_tests(files, test):
    d = tempfile.mkdtemp(prefix="bench-")
    for f, c in files.items():
        p = os.path.join(d, f); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(c)
    try:
        p = subprocess.run(["timeout", "20", "unshare", "-n", "python3", "-E", "-s", test], cwd=d, capture_output=True, text=True, timeout=30)
        out = (p.stdout + p.stderr)[-3000:]
        return (p.returncode == 0 and "ALL PASS" in p.stdout), out or "(no output)"
    except Exception as e:
        return False, f"error: {e}"

class Stats:
    def __init__(self): self.malformed = 0; self.repaired = 0; self.edit_fail = 0; self.test_edits = 0; self.tool_calls = 0

def replace_once(files, path, old, new, replace_all, st):
    if path not in files: st.edit_fail += 1; return f"ERROR: file {path!r} not found. Existing files: {sorted(files)}"
    n = files[path].count(old) if old else 0
    if n == 0: st.edit_fail += 1; return "ERROR: old text not found in file. Re-read the file and copy the text exactly, including indentation."
    if n > 1 and not replace_all: st.edit_fail += 1; return f"ERROR: old text found {n} times; include more surrounding lines to make it unique."
    files[path] = files[path].replace(old, new) if replace_all else files[path].replace(old, new, 1)
    return "OK: file updated."

def exec_tool(variant, name, args, files, test, st):
    st.tool_calls += 1
    get = lambda *ks: next((args[k] for k in ks if k in args), None)
    path = get("file_path", "path")
    if isinstance(path, str) and path.startswith("./"): path = path[2:]
    writes = name in ("edit_file", "write_file", "edit", "write") or (name == "str_replace_editor" and args.get("command") in ("create", "str_replace", "insert"))
    if writes and isinstance(path, str) and os.path.basename(path).startswith("test_"):
        st.test_edits += 1; return "ERROR: test files must not be modified."
    if name == "run_tests":
        ok, out = run_tests(files, test); return out
    if name in ("read_file", "read") or (name == "str_replace_editor" and args.get("command") == "view"):
        return numbered(files[path]) if path in files else f"ERROR: file {path!r} not found. Existing files: {sorted(files)}"
    if name in ("write_file", "write") or (name == "str_replace_editor" and args.get("command") == "create"):
        content = get("content", "file_text")
        if not isinstance(content, str): st.malformed += 1; return "ERROR: content must be a string."
        files[path] = content; return "OK: file written."
    if name == "edit_file" or (name == "str_replace_editor" and args.get("command") == "str_replace"):
        old, new = get("old_string", "old_str"), get("new_string", "new_str")
        if not isinstance(old, str) or not isinstance(new, str): st.malformed += 1; return "ERROR: old/new text must be strings."
        return replace_once(files, path, old, new, bool(args.get("replace_all")), st)
    if name == "str_replace_editor" and args.get("command") == "insert":
        if path not in files: return "ERROR: file not found"
        ln = args.get("insert_line"); lines = files[path].split("\n")
        if not isinstance(ln, int) or ln < 0 or ln > len(lines): st.edit_fail += 1; return "ERROR: bad insert_line"
        lines[ln:ln] = (args.get("new_str") or "").split("\n"); files[path] = "\n".join(lines); return "OK: inserted."
    if name == "edit":
        edits = args.get("edits")
        if isinstance(edits, str):
            st.malformed += 1
            try: edits = json.loads(edits); st.repaired += 1
            except Exception: return "ERROR: edits must be an array of {oldText,newText}."
        if isinstance(edits, dict): edits = [edits]; st.malformed += 1; st.repaired += 1
        if not isinstance(edits, list) or not edits: st.malformed += 1; return "ERROR: edits must be a non-empty array."
        if path not in files: st.edit_fail += 1; return f"ERROR: file {path!r} not found."
        orig = files[path]
        for e in edits:
            old = e.get("oldText") if isinstance(e, dict) else None
            if not isinstance(old, str) or orig.count(old) != 1:
                st.edit_fail += 1
                return f"ERROR: an oldText was {'not found' if not isinstance(old,str) or orig.count(old)==0 else 'not unique'}; no edits applied."
        new = orig
        for e in edits: new = new.replace(e["oldText"], e.get("newText", ""), 1)
        files[path] = new; return f"OK: {len(edits)} edit(s) applied."
    st.malformed += 1
    return f"ERROR: unknown tool or command {name}."

def episode(model, variant, task_name, rep, max_steps=16):
    t = tasks.T[task_name]; files = dict(t["files"]); st = Stats()
    listing = ", ".join(sorted(files))
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Workspace files: {listing}. Test file: {t['test']}.\nTask: {t['instruction']}"}]
    usage = {"prompt": 0, "completion": 0, "cached": 0}; final = ""; steps = 0; errors = []
    t0 = time.time()
    for steps in range(1, max_steps + 1):
        r = a6.chat({"model": model, "messages": msgs, "tools": VARIANTS[variant], "max_tokens": 8000},
                    tag=f"b-{model}-{variant}-{task_name}-{rep}-s{steps}", timeout=300)
        j = r["json"] or {}
        if r["status"] != 200 or not j.get("choices"):
            errors.append(f"http {r['status']}: {(r['raw'] or '')[:120]}")
            if len(errors) >= 3: break
            time.sleep(3); continue
        u = j.get("usage") or {}
        usage["prompt"] += u.get("prompt_tokens") or 0; usage["completion"] += u.get("completion_tokens") or 0
        usage["cached"] += (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        m = j["choices"][0]["message"]; calls = m.get("tool_calls") or []
        am = {k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "reasoning_content")}
        am["role"] = "assistant"; msgs.append(am)
        if not calls:
            final = (m.get("content") or "")
            if "[System Notice" in final: errors.append("relay-notice-as-content")
            break
        for c in calls:
            fn = c.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
                if not isinstance(args, dict): raise ValueError
                res = exec_tool(variant, fn.get("name"), args, files, t["test"], st)
            except Exception:
                st.malformed += 1; res = "ERROR: tool arguments are not valid JSON."
            msgs.append({"role": "tool", "tool_call_id": c.get("id"), "content": res})
    files_final = {**files, t["test"]: t["files"][t["test"]]}  # always judge with the ORIGINAL test file
    passed, _ = run_tests(files_final, t["test"])
    claimed = final.strip().upper().startswith("DONE")
    return {"model": model, "variant": variant, "task": task_name, "rep": rep, "passed": passed, "claimed_done": claimed,
            "false_claim": claimed and not passed, "steps": steps, "tool_calls": st.tool_calls, "malformed": st.malformed,
            "repaired": st.repaired, "edit_fail": st.edit_fail, "test_edit_attempts": st.test_edits, "errors": errors,
            "usage": usage, "secs": round(time.time() - t0, 1), "final": final[:120]}

if __name__ == "__main__":
    models = os.environ.get("MODELS", "deepseek-v4.1-flash-1017,glm-5.3,kimi-k3,qwen3.8-max,minimax-m3").split(",")
    variants = os.environ.get("VARIANTS", "flat,pi,editor").split(",")
    reps = int(os.environ.get("REPS", "2")); out = os.environ.get("OUT", os.path.join(HERE, "results_b.jsonl"))
    jobs = [(m, v, tn, r) for r in range(reps) for m in models for v in variants for tn in tasks.T]
    lock = threading.Lock()
    with cf.ThreadPoolExecutor(int(os.environ.get("WORKERS", "8"))) as ex:
        futs = {ex.submit(episode, *j): j for j in jobs}
        for f in cf.as_completed(futs):
            try: res = f.result()
            except Exception as e: res = {"job": futs[f], "crash": repr(e)}
            with lock:
                open(out, "a").write(json.dumps(res, ensure_ascii=False) + "\n")
                print(json.dumps({k: res.get(k) for k in ("model", "variant", "task", "rep", "passed", "steps", "malformed", "edit_fail", "false_claim", "crash")}, ensure_ascii=False), flush=True)
