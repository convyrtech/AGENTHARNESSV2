#!/usr/bin/env python3
"""Официальные счётчики токенов для отпечатка: tok(текст) − tok("hi"), без служебных токенов.

Нужны пакеты `tokenizers` и `tiktoken` (ставить в venv в scratchpad, не в систему). Скачанные файлы — данные:
код из них не исполняется (паттерн Kimi вынимается из tokenization_kimi.py как текст).

    python3 -I passport.py texts > texts.json
    VENV/bin/python -I tokcount.py --dl DL_DIR --texts texts.json --out official-counts.json

DL_DIR/qwen3.8/tokenizer.json, DL_DIR/deepseek-v4.1-flash-1017/tokenizer.json,
DL_DIR/kimi-k3/{tiktoken.model,tokenization_kimi.py}.
"""
import argparse
import json
import os
import re

# Полный промпт голого «hi» по официальному шаблону (для сравнения с prompt_tokens шлюза). Kimi K3 шаблон
# не публикует (в tokenizer_config.json нет chat_template) — для него только текст без обвязки.
HI_TEMPLATES = {
    # Qwen3.8 chat_template: без system ставит system с инструкцией усилия по умолчанию (xhigh).
    "qwen3.8-max": ("<|im_start|>system\nReasoning effort is set to xhigh. Please think carefully through the task, "
                    "validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, "
                    "and clarity in the final answer.<|im_end|>\n<|im_start|>user\nhi<|im_end|>\n"
                    "<|im_start|>assistant\n<think>\n"),
    # DeepSeek-V4.1 encoding/README.md: режим thinking, усилие по умолчанию 75.
    "deepseek-v4.1-flash-1017": ("<｜begin▁of▁sentence｜><｜System｜>Reasoning Effort: 75 (range 1-100, the higher the "
                                 "value, the more thorough the reasoning)\n\n<｜User｜>hi<｜Assistant｜><think>"),
}

SOURCES = {
    "qwen3.8-max": ("tokenizers", "qwen3.8/tokenizer.json", "Qwen/Qwen3.8-2.4T-A95B"),
    "deepseek-v4.1-flash-1017": ("tokenizers", "deepseek-v4.1-flash-1017/tokenizer.json",
                                 "deepseek-ai/DeepSeek-V4.1-Flash-1017"),
    "kimi-k3.1-pro": ("tiktoken", "kimi-k3/tiktoken.model", "moonshotai/Kimi-K3"),
}


def kimi_pattern(py_path: str) -> str:
    text = open(py_path, encoding="utf-8").read()
    block = re.search(r'pat_str\s*=\s*"\|"\.join\(\[(.*?)\]\)', text, re.S)
    if not block:
        raise SystemExit("не нашёл pat_str в tokenization_kimi.py")
    return "|".join(re.findall(r'r"""(.*?)"""', block.group(1), re.S))


def counter(kind: str, path: str):
    if kind == "tokenizers":
        from tokenizers import Tokenizer
        tok = Tokenizer.from_file(path)
        # Служебные токены в тексте шаблона распознаются как added tokens.
        return lambda s: len(tok.encode(s, add_special_tokens=False).ids)
    import tiktoken
    from tiktoken.load import load_tiktoken_bpe
    ranks = load_tiktoken_bpe(path)
    enc = tiktoken.Encoding(name="kimi", pat_str=kimi_pattern(os.path.join(os.path.dirname(path),
                                                                           "tokenization_kimi.py")),
                            mergeable_ranks=ranks, special_tokens={})
    return lambda s: len(enc.encode_ordinary(s))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dl", required=True)
    ap.add_argument("--texts", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    texts = json.load(open(a.texts, encoding="utf-8"))
    out = {}
    for model, (kind, rel, repo) in SOURCES.items():
        path = os.path.join(a.dl, rel)
        if not os.path.exists(path):
            continue
        count = counter(kind, path)
        hi = count(texts["hi"])
        out[model] = {name: count(t) - hi for name, t in texts.items() if name != "hi"}
        out[model]["_hi"] = hi
        if model in HI_TEMPLATES:
            out[model]["_hi_template"] = count(HI_TEMPLATES[model])
        out[model]["_source"] = repo
        print(model, out[model])
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
