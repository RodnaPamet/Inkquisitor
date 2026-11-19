import json, unicodedata
def esc_needed(ch):
    if ch == "\n": return False
    cat = unicodedata.category(ch)
    if cat in ("Cf","Cc","Co","Cs") and ch != "\n": return True
    if cat.startswith("Z") and ch != " ": return True
    try: name = unicodedata.name(ch)
    except ValueError: return True
    if ord(ch) > 0x7f and ("CYRILLIC" in name or "GREEK" in name or "FULLWIDTH" in name or "MATHEMATICAL" in name): return True
    return False
def dump(obj):
    s = json.dumps(obj, indent=2, ensure_ascii=False)
    return "".join(("\\u%04x" % ord(c)) if esc_needed(c) else c for c in s) + "\n"
def ans(i, sid, qk, q, keys, status, a, options=None, scale=None):
    d = {"id": i, "sessionId": sid, "questionKind": qk, "question": q}
    if options: d["options"] = options
    if scale: d["scaleLabels"] = scale
    d["targetsFieldKeys"] = keys; d["status"] = status; d["answer"] = a
    return d
def op(field, o, cites=(), must=(), mustnot=(), ref=None):
    return {"fieldKey": field, "op": o, "cites": list(cites), "mustContain": list(must), "mustNotContain": list(mustnot), "reference": ref}
def N(field): return op(field, "NO_CHANGE")
def R(field, cites): return op(field, "REMOVE", cites)
BASE = ["CITES_NO_ANSWER","CITES_FOREIGN_ANSWER","CITES_UNANSWERED","TARGETS_OUT_OF_SCOPE_FIELD","UNSOURCED_SENTENCE","PROPOSES_STORY_CONTENT"]
