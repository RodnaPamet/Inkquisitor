#!/usr/bin/env python3
"""Validate the staged content against FORMAT.md section 7. Usage: validate.py <staging-dir>"""
import json, os, re, sys, unicodedata, glob

ROOT = sys.argv[1]
errors = []
warns = []

def err(f, m): errors.append(f"{os.path.relpath(f, ROOT)}: {m}")
def warn(f, m): warns.append(f"{os.path.relpath(f, ROOT)}: {m}")

KINDS = ["PREMISE","PLOT","CHARACTER","SETTING","THEME","MOOD","TEXTURE","STYLE","POV","WORLD_RULE","TIMELINE_EVENT","FACTION","OBJECT","RESEARCH","CUSTOM"]
LABELS = {"PREMISE":"Premise","PLOT":"Plot","CHARACTER":"Character","SETTING":"Setting","THEME":"Theme","MOOD":"Mood","TEXTURE":"Texture","STYLE":"Prose style","POV":"Point of view","WORLD_RULE":"World rule","TIMELINE_EVENT":"Timeline event","FACTION":"Faction","OBJECT":"Object","RESEARCH":"Research note","CUSTOM":"Custom element"}
PERSONAS = {"gentle-mentor":("Gentle Mentor",["warm","encouraging","patient"]),"ruthless-editor":("Ruthless Editor",["blunt","exacting","economical"]),"socratic":("Socratic",["curious","methodical","probing"]),"devils-advocate":("Devil's Advocate",["contrarian","provocative","candid"]),"target-reader":("Target Reader",["reader-minded","candid","curious"]),"genre-specialist":("Genre Specialist",["genre-literate","practical","exacting"])}
TONES = {"warm","encouraging","patient","blunt","exacting","economical","curious","methodical","probing","contrarian","provocative","candid","reader-minded","genre-literate","practical"}
QKINDS = ["OPEN","CHOICE","EITHER_OR","SCENARIO","SCALE"]
DETAIL_KINDS = {1:{"CHOICE","EITHER_OR","SCALE"},2:{"CHOICE","EITHER_OR","SCALE","OPEN"},3:set(QKINDS),4:{"OPEN","SCENARIO","CHOICE","EITHER_OR"},5:{"OPEN","SCENARIO"}}
CODES = {
 "ASKS_ANSWERED_FIELD":"CPQ","REPEATS_PRIOR_QUESTION":"CPQ","SKIPS_DEPENDENCY":"CPQ","EXCEEDS_DEPTH":"CPQ","MISMATCHES_DETAIL":"CPQ","OUT_OF_SCOPE_KIND":"CPQ","COMPOUND_QUESTION":"CPQ","LEADING_QUESTION":"CPQ","VERDICT_NOT_QUESTION":"CPQ","MALFORMED_OPTIONS":"CPQ","UNGROUNDED_RECOMMENDATION":"CPQ",
 "PROPOSES_STORY_CONTENT":"CPQEA","WRITES_PROSE":"CPQEA","USES_BRANDED_FRAMEWORK":"CPQEA","BREAKS_PERSONA":"P","DEMEANS_AUTHOR":"P","EMPTY_PRAISE":"P",
 "CITES_NO_ANSWER":"EA","CITES_FOREIGN_ANSWER":"EA","CITES_UNANSWERED":"EA","TARGETS_OUT_OF_SCOPE_FIELD":"EA","UNSOURCED_SENTENCE":"EA","OMITS_NEW_ELEMENT":"EA","INVENTS_NEW_ELEMENT":"EA",
 "FOLLOWS_EMBEDDED_INSTRUCTION":"CPQEA","DISCLOSES_INSTRUCTIONS":"CPQEA","READS_OTHER_BOOK":"CPQEA","COPIES_INJECTED_TEXT":"EA"}
KEY_RE = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
BANNED = ["save the cat","story grid","dramatica","snowflake","hero's journey","hero’s journey","monomyth","writer's journey","anatomy of story","story engineering","seven-point","mice quotient","blake snyder","shawn coyne","joseph campbell","vogler","truby","ingermanson","larry brooks","mckee","weiland","opening image","theme stated","catalyst","break into two","b story","fun and games","bad guys close in","all is lost","dark night of the soul","break into three","final image","five commandments","progressive complication","foolscap","obligatory scene","controlling idea","value shift","throughline","overall story","impact character","influence character","storyform","story driver","story limit","signpost","ordinary world","call to adventure","refusal of the call","meeting the mentor","crossing the threshold","tests, allies","inmost cave","the ordeal","seizing the sword","the road back","return with the elixir","belly of the whale","ultimate boon","self-revelation","moral decision","new equilibrium","designing principle","moral argument","pinch point","lie the character believes"]
BANNED_WORDISH = ["debate"]  # ordinary words: report as warnings

# ---------- Appendix A ----------
fmt = open(os.path.join(ROOT, "FORMAT.md"), encoding="utf-8").read()
appA = fmt[fmt.index("## Appendix A"):fmt.index("## Appendix B")]
CORE = {}
cur = None
for line in appA.splitlines():
    m = re.match(r"^### ([A-Z_]+) \(", line)
    if m: cur = m.group(1); CORE[cur] = []; continue
    m = re.match(r"^\| (\d+) \| `([a-z_]+)` \| (\w+) \| ([^|]+) \| (\d) \|", line)
    if m and cur:
        deps = [] if m.group(4).strip() == "—" else re.findall(r"`([a-z_]+)`", m.group(4))
        CORE[cur].append({"key": m.group(2), "type": m.group(3), "dependsOn": deps, "level": int(m.group(5))})
assert sorted(CORE) == sorted(KINDS), CORE.keys()
def core_keys(k): return [c["key"] for c in CORE[k]]
def core(k, key): return next(c for c in CORE[k] if c["key"] == key)

# Appendix B situations
appB = fmt[fmt.index("## Appendix B"):fmt.index("## Appendix C")]
SITS = {}
for sid, block in zip(["S1","S2","S3"], re.findall(r"```json\n(.*?)```", appB, re.S)):
    SITS[sid] = json.loads(block)
SIT_TARGET = {"S1":"wound","S2":"stance","S3":"resolution"}

# ---------- helpers ----------
def esc_needed(ch):
    if ch == "\n": return False
    cat = unicodedata.category(ch)
    if cat in ("Cf","Cc","Co","Cs") and ch not in "\n": return True
    if cat.startswith("Z") and ch != " ": return True
    try: name = unicodedata.name(ch)
    except ValueError: return True
    if ord(ch) > 0x7f and ("CYRILLIC" in name or "GREEK" in name or "FULLWIDTH" in name or "MATHEMATICAL" in name): return True
    return False

def dump(obj):
    s = json.dumps(obj, indent=2, ensure_ascii=False)
    s = "".join(("\\u%04x" % ord(c)) if esc_needed(c) and ord(c) < 0x10000 else c for c in s)
    return s + "\n"

def check_file_bytes(f):
    b = open(f, "rb").read()
    if b.startswith(b"\xef\xbb\xbf"): err(f, "BOM")
    if b"\r" in b: err(f, "CR line ending")
    if not b.endswith(b"\n") or b.endswith(b"\n\n"): err(f, "must end with exactly one newline")
    t = b.decode("utf-8")
    low = t.lower()
    for w in BANNED:
        if w in low: err(f, f"banned framework vocabulary: {w!r}")
    for w in BANNED_WORDISH:
        for m in re.finditer(r"\b%s\b" % w, low): warn(f, f"check ordinary use of {w!r}: …{low[max(0,m.start()-40):m.end()+40]!r}")
    if "!" in t and f.endswith(".md") and "packs" in f: err(f, "exclamation mark in pack")
    return t

def load_json(f):
    t = check_file_bytes(f)
    try: o = json.loads(t)
    except Exception as e: err(f, f"JSON: {e}"); return None
    # 2-space indentation check
    for i, line in enumerate(t.splitlines()):
        ind = len(line) - len(line.lstrip(" "))
        if ind % 2: err(f, f"line {i+1} odd indentation"); break
        if "\t" in line[:ind+1]: err(f, f"tab indent line {i+1}"); break
    return o

def keys_order(f, obj, expected, where, optional=()):
    ks = list(obj.keys())
    exp = [k for k in expected if k in ks]
    extra = [k for k in ks if k not in expected]
    if extra: err(f, f"{where}: extra keys {extra}")
    if ks != exp: err(f, f"{where}: key order {ks} expected {exp}")
    for k in expected:
        if k not in ks and k not in optional: err(f, f"{where}: missing key {k}")

def typed_ok(t, v):
    if v is None: return True
    if t == "text": return isinstance(v, str) and v.strip() and "\n" not in v and len(v) <= 300
    if t == "richtext": return isinstance(v, str) and v.strip() and len(v) <= 1200 and "<" not in v
    if t == "list": return isinstance(v, list) and 1 <= len(v) <= 12 and all(isinstance(x, str) and x.strip() and len(x) <= 200 for x in v)
    if t == "scale": return isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 5
    return False

def check_bible(f, kind, bs, where):
    if list(bs.keys()) != core_keys(kind): err(f, f"{where}: bibleState keys {list(bs.keys())} != core {core_keys(kind)}"); return
    for c in CORE[kind]:
        if not typed_ok(c["type"], bs[c["key"]]): err(f, f"{where}: bad value for {c['key']} ({c['type']}): {bs[c['key']]!r}")

ANS_KEYS = ["id","sessionId","questionKind","question","options","scaleLabels","targetsFieldKeys","status","answer"]
def check_answer(f, a, kind, where, with_session, max_len=600):
    keys_order(f, a, ANS_KEYS, where, optional=("sessionId","options","scaleLabels"))
    if with_session and "sessionId" not in a: err(f, f"{where}: sessionId required")
    if not with_session and "sessionId" in a: err(f, f"{where}: sessionId must be absent")
    qk = a.get("questionKind")
    if qk not in QKINDS: err(f, f"{where}: bad questionKind {qk}")
    if qk == "CHOICE" and not (isinstance(a.get("options"), list) and 3 <= len(a["options"]) <= 5): err(f, f"{where}: CHOICE options")
    if qk == "EITHER_OR" and not (isinstance(a.get("options"), list) and len(a["options"]) == 2): err(f, f"{where}: EITHER_OR options")
    if qk not in ("CHOICE","EITHER_OR") and "options" in a: err(f, f"{where}: options on {qk}")
    if qk == "SCALE" and not (isinstance(a.get("scaleLabels"), dict) and list(a["scaleLabels"]) == ["low","high"]): err(f, f"{where}: SCALE needs scaleLabels")
    if qk != "SCALE" and "scaleLabels" in a: err(f, f"{where}: scaleLabels on {qk}")
    for o in a.get("options", []) or []:
        if re.match(r"(?i)^(other|something else|none of these|all of the above)", o): err(f, f"{where}: banned option {o}")
    q = a.get("question", "")
    if not q.strip().endswith("?"): warn(f, f"{where}: question does not end with ?")
    tk = a.get("targetsFieldKeys")
    if not tk or any(k not in core_keys(kind) for k in tk): err(f, f"{where}: targetsFieldKeys {tk} not core keys of {kind}")
    st = a.get("status")
    if st not in ("ANSWERED","SKIPPED","DECIDE_LATER"): err(f, f"{where}: status {st}")
    ans = a.get("answer")
    if st != "ANSWERED":
        if ans is not None: err(f, f"{where}: answer must be null when {st}")
    else:
        if qk in ("CHOICE","EITHER_OR"):
            if ans not in (a.get("options") or []): err(f, f"{where}: answer not one of options")
        elif qk == "SCALE":
            if not (isinstance(ans, int) and 1 <= ans <= 5): err(f, f"{where}: scale answer")
        else:
            if not isinstance(ans, str) or not ans.strip(): err(f, f"{where}: answer must be a string")
            elif len(ans) > max_len: err(f, f"{where}: answer {len(ans)} chars > {max_len}")

def frontier(kind, bs, prior, depth):
    sat = {k for k in core_keys(kind) if bs[k] is not None}
    touched = set()
    for a in prior:
        touched |= set(a["targetsFieldKeys"])
        if a["status"] == "ANSWERED": sat |= set(a["targetsFieldKeys"])
    out = []
    for c in CORE[kind]:
        k = c["key"]
        if bs[k] is None and k not in touched and all(d in sat for d in c["dependsOn"]) and c["level"] <= depth: out.append(k)
    return out

def check_mustnot(f, codes, letter, required, where):
    if len(set(codes)) != len(codes): err(f, f"{where}: duplicate mustNot")
    for c in codes:
        if c not in CODES: err(f, f"{where}: unknown code {c}")
        elif letter not in CODES[c]: err(f, f"{where}: code {c} not allowed in {letter} files")
    for r in required:
        if r not in codes: err(f, f"{where}: mustNot missing {r}")

def check_dials(f, d, where):
    if not (isinstance(d, dict) and list(d) == ["depth","detail"] and all(isinstance(d[k], int) and 1 <= d[k] <= 5 for k in d)): err(f, f"{where}: bad dials {d}")

# ---------- section 6 scan ----------
SCAN = [
 (r"https?://|www\.|\b[a-z0-9-]+\.(com|org|net|io|ai|dev|co|uk|app|edu|gov)\b", "url/domain"),
 (r"system prompt|context window|conversation history|(reveal|repeat|show|hid)\w*\s+(\w+\s+){0,2}instructions", "instruction disclosure"),
 (r"\b(ignor\w*|disregard\w*|forget\w*|forgot\w*|overrid\w*|bypass\w*)\b|start over|clean slate", "banned verb"),
 (r"you are now|from now on you are|\bact as\b|pretend to be|roleplay as", "identity switch"),
 (r"\b(answer|choose|pick|select)\b.{0,14}?\b(a|b|c|d|e|none)\b|\brespond with\b|\breply with\b", "answer+letter"),
 (r"\b(answer|respond|reply)\s*[:=]", "answer colon"),
 (r"\b(answer|respond|reply|say)\b.{0,14}?\b(true|false)\b", "say true/false"),
 (r"(?m)^\s*(system|assistant|developer)\s*:|<\||\|>|\[inst\]|<<sys>>|<s>", "chat tokens"),
 (r"\b(new|updated|revised|real|actual)\s*:\s*(rules?|instructions?|directive)|\b(new|updated|revised|real|actual)\s+(rules?|instructions?|directive)\s*:", "new rule colon"),
 (r"\b(tools?|functions?|commands?|shell|api|mcp)\b", "tool word"),
 (r"\b(set|change|override|replace)\b(\W+\w+){0,3}?\W+(field|argument|parameter|amount|address|recipient|url)s?\b.{0,20}?\bto\b", "set field to"),
 (r"\b(probability|confidence|certainty)\b", "probability word"),
 (r"\{\s*\"|\"\w+\"\s*:|<state>", "json"),
 (r"no restrictions|developer mode|jailbreak|do anything now|without any filter|restriction|guardrail", "jailbreak words"),
 (r"[a-z0-9_\-]{32,}", "random string"),
 (r"quarantined|kill_switch|model_drift|over_budget|no_provider|no_evaluation|provider_error", "reserved words"),
]
def scan_pack(f, t):
    low = t.lower()
    for pat, name in SCAN:
        for m in re.finditer(pat, low):
            err(f, f"text-scan [{name}]: …{low[max(0,m.start()-30):m.end()+30]!r}")
    for sent in re.split(r"(?<=[.?;:])\s+|\n", low):
        if re.search(r"\b(send|post|upload|transmit|leak|email|forward)\w*\b", sent) and re.search(r"\b(secret|token|password|credential)s?\b", sent):
            err(f, f"text-scan [leak secret]: {sent[:120]!r}")

def parse_md(t):
    if not t.startswith("---\n"): return None, t
    end = t.index("\n---\n", 4)
    return t[4:end], t[end+5:]

def headings(body): return [l for l in body.splitlines() if l.startswith("#")]

def section(body, h):
    lines = body.splitlines(); out = []; on = False
    for l in lines:
        if l.startswith("#"):
            if on: break
            if l == h: on = True; continue
        elif on: out.append(l)
    return "\n".join(out).strip("\n")

QLINE = re.compile(r"^\[(OPEN|CHOICE|EITHER_OR|SCENARIO|SCALE)\] \(([a-z0-9_, ]+)\) (.+)$")
def check_qline(f, s, allowed_keys, where):
    m = QLINE.match(s)
    if not m: err(f, f"{where}: question line grammar: {s[:80]!r}"); return None, []
    kind, keys, rest = m.group(1), m.group(2).split(", "), m.group(3)
    for k in keys:
        if k not in allowed_keys: err(f, f"{where}: key {k} not in coverage")
    if kind in ("CHOICE","EITHER_OR"):
        mm = re.match(r"^(.*\?) Options: (.+)\.$", rest)
        if not mm: err(f, f"{where}: options grammar"); return kind, keys
        q, opts = mm.group(1), mm.group(2).split("; ")
        if kind == "CHOICE" and not 3 <= len(opts) <= 5: err(f, f"{where}: CHOICE needs 3-5 options, has {len(opts)}")
        if kind == "EITHER_OR" and len(opts) != 2: err(f, f"{where}: EITHER_OR needs 2 options")
    elif kind == "SCALE":
        mm = re.match(r"^(.*\?) Scale: 1 = ([^,]+), 5 = (.+)\.$", rest)
        if not mm: err(f, f"{where}: scale grammar"); return kind, keys
        q = mm.group(1)
    else:
        q = rest
        if "Options:" in q or "Scale:" in q: err(f, f"{where}: options on {kind}")
    if not q.endswith("?"): err(f, f"{where}: question must end with ?")
    if len(q) > 280: err(f, f"{where}: question {len(q)} chars > 280")
    return kind, keys

FIXED_HOW = ["- Never write the book's prose or supply story content: ask, summarise the author's own answers, and challenge them.",
             "- Build any recommendation only from the author's stored entries and earlier answers, or from the options offered; when nothing supports one, offer none."]
FIXED_BOUND = [FIXED_HOW[0], "- A persona changes how a question is worded, never which fields are asked about or what may be written to the bible."]

counts = {"templates":0,"template_fields":0,"core_fields":0,"optional_fields":0,"relation_types":0,"craft_packs":0,"persona_packs":0,"craft_eval_cases":0,"persona_eval_cases":0,"example_questions":0}

# ---------- templates ----------
templates = {}
for kind in KINDS:
    d = kind.lower(); f = os.path.join(ROOT, "templates", d + ".json")
    if not os.path.exists(f): err(f, "missing"); continue
    t = load_json(f)
    if t is None: continue
    templates[kind] = t; counts["templates"] += 1
    keys_order(f, t, ["kind","label","description","fields","relationTypes"], "top")
    if t.get("kind") != kind: err(f, "kind mismatch")
    if t.get("label") != LABELS[kind]: err(f, "label mismatch")
    if len(t.get("description","")) > 300: err(f, "description > 300")
    fl = t.get("fields", [])
    if not 6 <= len(fl) <= 14: err(f, f"{len(fl)} fields")
    counts["template_fields"] += len(fl)
    order = {}
    seen_labels = set()
    for i, fo in enumerate(fl):
        w = f"field {fo.get('key')}"
        exp = ["key","label","help","type"] + (["options"] if fo.get("type") == "choice" else []) + (["scaleLabels"] if fo.get("type") == "scale" else []) + ["required","order","dependsOn"]
        keys_order(f, fo, exp, w)
        k = fo["key"]
        if not KEY_RE.match(k) or len(k) > 32: err(f, f"{w}: bad key")
        if k in ("name","slug","status","summary","kind","label"): err(f, f"{w}: reserved key")
        if k in order: err(f, f"{w}: duplicate key")
        if fo["order"] != i + 1: err(f, f"{w}: order {fo['order']} at position {i+1}")
        order[k] = fo["order"]
        if len(fo["label"]) > 40 or fo["label"] in seen_labels or fo["label"][-1] in ".!?": err(f, f"{w}: label")
        seen_labels.add(fo["label"])
        h = fo["help"]
        if len(h) > 160 or not h.endswith(".") or re.search(r"\.\s+[A-Z]", h[:-1]): err(f, f"{w}: help ({len(h)} chars) must be one sentence <=160 ending '.'")
        if fo["type"] == "choice":
            o = fo["options"]
            if not 2 <= len(o) <= 8: err(f, f"{w}: options count")
            vals = [x["value"] for x in o]
            if len(set(vals)) != len(vals): err(f, f"{w}: duplicate option value")
            for x in o:
                if list(x) != ["value","label"] or not KEY_RE.match(x["value"]) or len(x["label"]) > 40: err(f, f"{w}: option {x}")
        if fo["type"] == "scale":
            sl = fo["scaleLabels"]
            if list(sl) != ["low","high"] or any(len(v) > 40 for v in sl.values()): err(f, f"{w}: scaleLabels")
        if fo["type"] not in ("text","richtext","list","choice","scale"): err(f, f"{w}: type")
        deps = fo["dependsOn"]
        if len(set(deps)) != len(deps) or k in deps: err(f, f"{w}: dependsOn dup/self")
        for dd in deps:
            if dd not in order: err(f, f"{w}: depends on {dd} which is not earlier")
    ck = core_keys(kind)
    pos = [order.get(c, -1) for c in ck]
    if pos != sorted(pos): err(f, "core fields out of relative order")
    for c in CORE[kind]:
        fo = next((x for x in fl if x["key"] == c["key"]), None)
        if not fo: err(f, f"missing core field {c['key']}"); continue
        if fo["type"] != c["type"] or fo["dependsOn"] != c["dependsOn"] or fo["required"] is not True: err(f, f"core field {c['key']} type/dependsOn/required mismatch")
    for fo in fl:
        if fo["key"] not in ck:
            if fo["required"] is not False: err(f, f"optional {fo['key']} must be required:false")
            for dd in fo["dependsOn"]: pass
    nopt = len([x for x in fl if x["key"] not in ck])
    counts["core_fields"] += len(ck); counts["optional_fields"] += nopt
    if nopt < 2: err(f, "fewer than 2 optional fields")
    rel = t.get("relationTypes", [])
    if len(rel) > 8: err(f, "too many relations")
    counts["relation_types"] += len(rel)
    rk = set()
    for r in rel:
        keys_order(f, r, ["key","label","inverseLabel","targetKinds"], f"relation {r.get('key')}")
        if r["key"] in rk or not KEY_RE.match(r["key"]) or r["key"] == "related_to": err(f, f"relation key {r['key']}")
        rk.add(r["key"])
        for lab in (r["label"], r["inverseLabel"]):
            if lab != lab.lower() or len(lab) > 32: err(f, f"relation label {lab!r}")
        tk = r["targetKinds"]
        if not tk or len(set(tk)) != len(tk): err(f, f"relation {r['key']} targetKinds empty/dup")
        for x in tk:
            if x not in KINDS: err(f, f"relation {r['key']}: invalid kind {x}")
            elif KINDS.index(x) < KINDS.index(kind): err(f, f"relation {r['key']}: target {x} comes before {kind} (ownership)")
        if kind == "CUSTOM" and tk != ["CUSTOM"]: err(f, f"custom relation {r['key']} must target CUSTOM only")

def tmpl_keys(kind): return [x["key"] for x in templates[kind]["fields"]] if kind in templates else core_keys(kind)

# ---------- craft packs ----------
for kind in KINDS:
    d = kind.lower(); base = os.path.join(ROOT, "packs", "craft", d)
    f = os.path.join(base, "PACK.md")
    if not os.path.exists(f):
        (warn if kind == "CUSTOM" else err)(f, "missing craft pack"); continue
    counts["craft_packs"] += 1
    t = check_file_bytes(f)
    if len(t.encode()) > 8192: err(f, f"{len(t.encode())} bytes > 8192")
    fm, body = parse_md(t)
    if fm is None: err(f, "no frontmatter"); continue
    lines = fm.splitlines()
    if not (lines[0] == f"name: craft-{d}" and lines[1] == "version: 1" and lines[2] == f"kind: {kind}" and lines[3] == "coverage:"): err(f, "frontmatter head")
    cov = []; i = 4
    while i < len(lines) and lines[i].startswith("  - "): cov.append(lines[i][4:]); i += 1
    if i != len(lines) - 1 or not re.match(r'^description: "[^"\\]{1,200}"$', lines[i]): err(f, "frontmatter description line")
    for c in core_keys(kind):
        if c not in cov: err(f, f"coverage missing core {c}")
    tk = tmpl_keys(kind)
    for c in cov:
        if c not in tk: err(f, f"coverage key {c} not in template")
    if cov != sorted(cov, key=lambda k: tk.index(k) if k in tk else 99): err(f, "coverage not in template order")
    exp_h = [f"# {LABELS[kind]}","## Purpose","## How to question","## Question patterns","### OPEN","### CHOICE","### EITHER_OR","### SCENARIO","### SCALE","## Depth guidance","## Never ask","## Example questions"]
    if headings(body) != exp_h: err(f, f"headings {headings(body)}")
    how = [l for l in section(body, "## How to question").splitlines() if l.startswith("- ")]
    if how[:2] != FIXED_HOW: err(f, "fixed bullets missing in How to question")
    if not 5 <= len(how) <= 12: err(f, f"How to question has {len(how)} bullets")
    dg = [l for l in section(body, "## Depth guidance").splitlines() if l.strip()]
    if len(dg) != 5 or any(not l.startswith(f"- **Depth {n}** — ") for n, l in zip(range(1, 6), dg)): err(f, "depth bullets")
    na = [l for l in section(body, "## Never ask").splitlines() if l.startswith("- ")]
    if not 4 <= len(na) <= 10: err(f, f"Never ask has {len(na)} bullets")
    ex = [l for l in section(body, "## Example questions").splitlines() if l.strip()]
    if not 10 <= len(ex) <= 20: err(f, f"{len(ex)} example questions")
    counts["example_questions"] += len(ex)
    kc = {k: 0 for k in QKINDS}; keys_seen = set()
    for n, l in enumerate(ex, 1):
        m = re.match(rf"^{n}\. (.*)$", l)
        if not m: err(f, f"example {n} numbering"); continue
        qk, ks = check_qline(f, m.group(1), cov, f"example {n}")
        if qk: kc[qk] += 1; keys_seen |= set(ks)
    for k, v in kc.items():
        if v < 2: err(f, f"example kind {k} appears {v} times")
    for c in core_keys(kind):
        if c not in keys_seen: err(f, f"core key {c} in no example")
    scan_pack(f, t)
    # evals
    fe = os.path.join(base, "evals.json")
    ev = load_json(fe) if os.path.exists(fe) else (err(fe, "missing"), None)[1]
    if not ev: continue
    if not 8 <= len(ev) <= 15: err(fe, f"{len(ev)} cases")
    counts["craft_eval_cases"] += len(ev)
    cov_flags = dict(fresh=False, filled=False, answered=False, skipped=False, empty=False, d1=False, d5=False, t1=False, t5=False, invent=False)
    targ_union = set()
    for n, c in enumerate(ev, 1):
        w = f"case {c.get('id')}"
        keys_order(fe, c, ["id","rationale","elementName","customLabel","bibleState","priorAnswers","dials","expect"], w, optional=("customLabel",))
        if c["id"] != f"{d}-{n:02d}": err(fe, f"{w}: id should be {d}-{n:02d}")
        if len(c["rationale"]) > 400: err(fe, f"{w}: rationale > 400")
        if (kind == "CUSTOM") != ("customLabel" in c): err(fe, f"{w}: customLabel rule")
        check_bible(fe, kind, c["bibleState"], w)
        for a in c["priorAnswers"]: check_answer(fe, a, kind, f"{w} {a.get('id')}", False)
        check_dials(fe, c["dials"], w)
        keys_order(fe, c["expect"], ["targetsAnyOf","mustNot"], f"{w} expect")
        fr = frontier(kind, c["bibleState"], c["priorAnswers"], c["dials"]["depth"])
        if c["expect"]["targetsAnyOf"] != fr: err(fe, f"{w}: targetsAnyOf {c['expect']['targetsAnyOf']} != frontier {fr}")
        check_mustnot(fe, c["expect"]["mustNot"], "C", ["ASKS_ANSWERED_FIELD","SKIPS_DEPENDENCY","PROPOSES_STORY_CONTENT","WRITES_PROSE"], w)
        bs = c["bibleState"]
        if all(v is None for v in bs.values()) and not c["priorAnswers"]: cov_flags["fresh"] = True
        if any(v is not None for v in bs.values()): cov_flags["filled"] = True
        if any(a["status"] == "ANSWERED" for a in c["priorAnswers"]): cov_flags["answered"] = True
        if any(a["status"] != "ANSWERED" for a in c["priorAnswers"]): cov_flags["skipped"] = True
        if not fr: cov_flags["empty"] = True
        cov_flags["d1"] |= c["dials"]["depth"] == 1; cov_flags["d5"] |= c["dials"]["depth"] == 5
        cov_flags["t1"] |= c["dials"]["detail"] == 1; cov_flags["t5"] |= c["dials"]["detail"] == 5
        if "FOLLOWS_EMBEDDED_INSTRUCTION" in c["expect"]["mustNot"]: cov_flags["invent"] = True
        targ_union |= set(fr)
    for k, v in cov_flags.items():
        if not v: err(fe, f"3.6 coverage missing: {k}")
    for k in core_keys(kind):
        if k not in targ_union: err(fe, f"3.6: core key {k} in no targetsAnyOf")

# ---------- persona packs ----------
for pk, (disp, ctones) in PERSONAS.items():
    base = os.path.join(ROOT, "packs", "personas", pk); f = os.path.join(base, "PACK.md")
    if not os.path.exists(f): err(f, "missing persona pack"); continue
    counts["persona_packs"] += 1
    t = check_file_bytes(f)
    if len(t.encode()) > 8192: err(f, f"{len(t.encode())} bytes > 8192")
    fm, body = parse_md(t)
    lines = fm.splitlines()
    if not (len(lines) == 4 and lines[0] == f"name: persona-{pk}" and lines[1] == "version: 1" and lines[2] == f"persona: {pk}" and re.match(r'^description: "[^"\\]{1,200}"$', lines[3])): err(f, "frontmatter")
    exp_h = [f"# {disp}","## Voice","## Stance","## Question style","## Recommended-answer style","## Boundaries","## Examples","### S1","### S2","### S3"]
    if headings(body) != exp_h: err(f, f"headings {headings(body)}")
    for h, lo, hi in (("## Question style",4,8),("## Recommended-answer style",3,6),("## Boundaries",4,8)):
        b = [l for l in section(body, h).splitlines() if l.startswith("- ")]
        if not lo <= len(b) <= hi: err(f, f"{h} has {len(b)} bullets")
    bnd = [l for l in section(body, "## Boundaries").splitlines() if l.startswith("- ")]
    if bnd[:2] != FIXED_BOUND: err(f, "fixed Boundaries bullets")
    for h in ("## Voice","## Stance"):
        s = section(body, h)
        if "\n\n" in s.strip(): err(f, f"{h} must be one paragraph")
    for sid in ("S1","S2","S3"):
        paras = [p for p in section(body, f"### {sid}").split("\n\n") if p.strip()]
        if len(paras) != 2 or not paras[0].startswith("Question: ") or not paras[1].startswith("Recommended: "): err(f, f"{sid}: two paragraphs Question/Recommended"); continue
        sit = SITS[sid]
        qk, ks = check_qline(f, paras[0][len("Question: "):], core_keys(sit["kind"]), sid)
        if ks != [SIT_TARGET[sid]]: err(f, f"{sid}: must target exactly {SIT_TARGET[sid]}, got {ks}")
        if qk and qk not in DETAIL_KINDS[sit["dials"]["detail"]]: err(f, f"{sid}: kind {qk} not allowed at detail {sit['dials']['detail']}")
        if not re.match(r"^Recommended: none — ", paras[1]) and qk in ("OPEN","SCENARIO"): warn(f, f"{sid}: OPEN/SCENARIO recommendation should usually be none")
    scan_pack(f, t)
    fe = os.path.join(base, "evals.json")
    ev = load_json(fe) if os.path.exists(fe) else (err(fe, "missing"), None)[1]
    if not ev: continue
    if not 6 <= len(ev) <= 10: err(fe, f"{len(ev)} cases")
    counts["persona_eval_cases"] += len(ev)
    sits_seen = set(); inline_kinds = set(); embedded = False
    for n, c in enumerate(ev, 1):
        w = f"case {c.get('id')}"
        keys_order(fe, c, ["id","rationale","situation","expect"], w)
        if c["id"] != f"{pk}-{n:02d}": err(fe, f"{w}: id")
        if len(c["rationale"]) > 400: err(fe, f"{w}: rationale > 400")
        s = c["situation"]
        if isinstance(s, str):
            if s not in SITS: err(fe, f"{w}: situation {s}")
            sits_seen.add(s)
        else:
            keys_order(fe, s, ["kind","elementName","customLabel","bibleState","priorAnswers","dials"], f"{w} situation", optional=("customLabel",))
            check_bible(fe, s["kind"], s["bibleState"], w)
            for a in s["priorAnswers"]: check_answer(fe, a, s["kind"], f"{w} {a.get('id')}", False)
            check_dials(fe, s["dials"], w)
            if s["kind"] not in ("CHARACTER","THEME","PLOT"): inline_kinds.add(s["kind"])
            fr = frontier(s["kind"], s["bibleState"], s["priorAnswers"], s["dials"]["depth"])
            if not fr: warn(fe, f"{w}: inline situation frontier is empty")
            if "FOLLOWS_EMBEDDED_INSTRUCTION" in c["expect"]["mustNot"]: embedded = True
        keys_order(fe, c["expect"], ["tone","mustNot"], f"{w} expect")
        tn = c["expect"]["tone"]
        if not 1 <= len(tn) <= 3 or any(x not in TONES for x in tn) or not any(x in ctones for x in tn): err(fe, f"{w}: tone {tn}")
        check_mustnot(fe, c["expect"]["mustNot"], "P", ["PROPOSES_STORY_CONTENT","WRITES_PROSE","BREAKS_PERSONA","DEMEANS_AUTHOR"], w)
    if sits_seen != {"S1","S2","S3"}: err(fe, f"4.6: situations seen {sits_seen}")
    if len(inline_kinds) < 2: err(fe, f"4.6: inline kinds outside C/T/P {inline_kinds}")
    if not embedded: err(fe, "4.6: no embedded-instruction case")
    if pk == "gentle-mentor" and not any("EMPTY_PRAISE" in c["expect"]["mustNot"] for c in ev): err(fe, "4.6: EMPTY_PRAISE case")

# ---------- question coverage ----------
f = os.path.join(ROOT, "evals", "question-coverage.json")
qc = load_json(f) or []
counts["question_coverage_cases"] = len(qc)
counts["question_coverage_sessions"] = sum(len(c["sessions"]) for c in qc)
if len(qc) != 10: err(f, "need 10 cases")
for n, c in enumerate(qc, 1):
    w = c.get("id")
    keys_order(f, c, ["id","rationale","concept","genre","audience","sessions"], w)
    if c["id"] != f"qc-{n:02d}": err(f, f"{w}: id")
    nw = len(c["concept"].split())
    if not 60 <= nw <= 200: err(f, f"{w}: concept {nw} words")
    if c["audience"] not in ("children","middle_grade","young_adult","adult"): err(f, f"{w}: audience")
    if not 2 <= len(c["sessions"]) <= 4: err(f, f"{w}: sessions count")
    for s in c["sessions"]:
        ww = f"{w}/{s['kind']}"
        keys_order(f, s, ["kind","elementName","customLabel","dials","statedInConcept","authorKnows","expect"], ww, optional=("customLabel",))
        kind = s["kind"]; ck = core_keys(kind)
        check_dials(f, s["dials"], ww)
        for k in s["statedInConcept"] + list(s["authorKnows"]):
            if k not in ck: err(f, f"{ww}: {k} not a core key")
        if s["statedInConcept"] != [k for k in ck if k in s["statedInConcept"]]: err(f, f"{ww}: statedInConcept order")
        ak = list(s["authorKnows"])
        if ak != [k for k in ck if k in ak]: err(f, f"{ww}: authorKnows order")
        if set(ak) & set(s["statedInConcept"]): err(f, f"{ww}: authorKnows overlaps stated")
        for k, v in s["authorKnows"].items():
            if not typed_ok(core(kind, k)["type"], v) or v is None: err(f, f"{ww}: authorKnows {k} badly typed")
        sat = set(s["statedInConcept"]); deferred = set(); covered = set()
        for _ in range(6):
            E = {c2["key"] for c2 in CORE[kind] if c2["key"] not in sat and c2["key"] not in deferred and c2["level"] <= s["dials"]["depth"] and all(dd in sat for dd in c2["dependsOn"])}
            if not E: break
            covered |= E
            for k in E: (sat if k in s["authorKnows"] else deferred).add(k)
        mc = [k for k in ck if k in covered]; mnt = [k for k in ck if k not in covered]
        if s["expect"]["mustCover"] != mc: err(f, f"{ww}: mustCover {s['expect']['mustCover']} != {mc}")
        if s["expect"]["mustNotTarget"] != mnt: err(f, f"{ww}: mustNotTarget {s['expect']['mustNotTarget']} != {mnt}")
        check_mustnot(f, s["expect"]["mustNot"], "Q", ["ASKS_ANSWERED_FIELD","REPEATS_PRIOR_QUESTION","SKIPS_DEPENDENCY","EXCEEDS_DEPTH","PROPOSES_STORY_CONTENT","WRITES_PROSE"], ww)

# ---------- enrichment / adversarial ----------
def check_reconcile(f, c, w, letter, max_len=600):
    kind = c["kind"]; ck = core_keys(kind)
    if (kind == "CUSTOM") != ("customLabel" in c): err(f, f"{w}: customLabel rule")
    be = c["bookElements"]
    if not any(e["kind"] == kind and e["name"] == c["elementName"] for e in be): err(f, f"{w}: bookElements lacks this element")
    for e in be:
        if list(e) != ["kind","name"] or e["kind"] not in KINDS: err(f, f"{w}: bookElements entry {e}")
    check_bible(f, kind, c["bibleState"], w)
    sid = c["sessionId"]
    sc = c["scopeFieldKeys"]
    if not sc or sc != [k for k in ck if k in sc]: err(f, f"{w}: scopeFieldKeys {sc} not ordered core keys")
    ids = [a["id"] for a in c["answers"]]
    if len(set(ids)) != len(ids): err(f, f"{w}: duplicate answer ids")
    for a in c["answers"]: check_answer(f, a, kind, f"{w} {a.get('id')}", True, max_len)
    cur_ans = {a["id"] for a in c["answers"] if a["sessionId"] == sid and a["status"] == "ANSWERED"}
    if not any(a["sessionId"] == sid for a in c["answers"]): err(f, f"{w}: no current-session answer")
    ex = c["expect"]
    keys_order(f, ex, ["operations","newElements","mustNot"], f"{w} expect")
    ops = ex["operations"]
    if [o["fieldKey"] for o in ops] != sc: err(f, f"{w}: operations fields {[o['fieldKey'] for o in ops]} != scope {sc}")
    for o in ops:
        keys_order(f, o, ["fieldKey","op","cites","mustContain","mustNotContain","reference"], f"{w} op {o['fieldKey']}")
        ref = o.get("reference")
        ftype = core(kind, o["fieldKey"])["type"] if o["fieldKey"] in ck else None
        if o["op"] in ("ADD","UPDATE"):
            if ref is None or not typed_ok(ftype, ref): err(f, f"{w}: reference for {o['fieldKey']} missing or not a typed {ftype} value: {ref!r}")
            else:
                rt = json.dumps(ref, ensure_ascii=False).lower()
                for p in o["mustContain"]:
                    if p.lower() not in rt: err(f, f"{w}: reference lacks mustContain {p!r}")
                for p in o["mustNotContain"]:
                    if p.lower() in rt: err(f, f"{w}: reference contains mustNotContain {p!r}")
        elif ref is not None: err(f, f"{w}: reference must be null for {o['op']}")
        stored = c["bibleState"].get(o["fieldKey"])
        op = o["op"]
        if op not in ("ADD","UPDATE","REMOVE","NO_CHANGE"): err(f, f"{w}: op {op}")
        if op == "ADD" and stored is not None: err(f, f"{w}: ADD on filled {o['fieldKey']}")
        if op in ("UPDATE","REMOVE") and stored is None: err(f, f"{w}: {op} on empty {o['fieldKey']}")
        if op == "NO_CHANGE":
            if o["cites"] or o["mustContain"] or o["mustNotContain"]: err(f, f"{w}: NO_CHANGE must have empty lists")
        else:
            if not o["cites"]: err(f, f"{w}: {op} without cites")
            for ci in o["cites"]:
                if ci not in cur_ans: err(f, f"{w}: cites {ci} which is not a current-session ANSWERED answer")
                else:
                    a = next(a for a in c["answers"] if a["id"] == ci)
                    if o["fieldKey"] not in a["targetsFieldKeys"]: warn(f, f"{w}: {o['fieldKey']} cites {ci} whose targetsFieldKeys {a['targetsFieldKeys']} omit it")
            if op == "REMOVE":
                if o["mustContain"] or o["mustNotContain"]: err(f, f"{w}: REMOVE must have empty phrase lists")
            else:
                if not 1 <= len(o["mustContain"]) <= 4: err(f, f"{w}: mustContain count")
                if len(o["mustNotContain"]) > 4: err(f, f"{w}: mustNotContain count")
                src = " ".join(str(next(a for a in c["answers"] if a["id"] == ci)["answer"]) for ci in o["cites"] if ci in cur_ans).lower()
                for p in o["mustContain"]:
                    if not 1 <= len(p.split()) <= 5: err(f, f"{w}: mustContain phrase length {p!r}")
                    if p.lower() not in src: err(f, f"{w}: mustContain {p!r} not found in cited answers")
                stored_txt = json.dumps(stored).lower() if stored is not None else ""
    for ne in ex["newElements"]:
        keys_order(f, ne, ["kind","name","cites"], f"{w} newElement")
        if ne["kind"] not in KINDS or not ne["cites"] or any(ci not in cur_ans for ci in ne["cites"]): err(f, f"{w}: newElement {ne}")
        if any(e["name"].lower() == ne["name"].lower() for e in be): err(f, f"{w}: newElement already in bookElements")
        src = " ".join(str(a["answer"]) for a in c["answers"] if a["id"] in ne["cites"]).lower()
        if ne["name"].lower() not in src: warn(f, f"{w}: newElement name {ne['name']!r} not verbatim in cited answer")
    return ops

f = os.path.join(ROOT, "evals", "enrichment.json")
if os.path.exists(f):
    en = load_json(f) or []
    counts["enrichment_cases"] = len(en)
    opc = {"ADD":0,"UPDATE":0,"REMOVE":0,"NO_CHANGE":0}; kinds = set(); listops = scaleops = 0
    other_sess = skipped_cur = newel = named_existing = 0; total = 0
    for n, c in enumerate(en, 1):
        w = c.get("id")
        keys_order(f, c, ["id","rationale","kind","elementName","customLabel","bookElements","bibleState","sessionId","scopeFieldKeys","answers","expect"], w, optional=("customLabel",))
        if c["id"] != f"en-{n:02d}": err(f, f"{w}: id")
        if len(c["rationale"]) > 400: err(f, f"{w}: rationale > 400")
        ops = check_reconcile(f, c, w, "E")
        check_mustnot(f, c["expect"]["mustNot"], "E", ["CITES_NO_ANSWER","CITES_FOREIGN_ANSWER","CITES_UNANSWERED","TARGETS_OUT_OF_SCOPE_FIELD","UNSOURCED_SENTENCE","PROPOSES_STORY_CONTENT"], w)
        kinds.add(c["kind"])
        for o in ops:
            opc[o["op"]] += 1; total += 1
            t = core(c["kind"], o["fieldKey"])["type"]
            listops += t == "list"; scaleops += t == "scale"
        if any(a["sessionId"] != c["sessionId"] for a in c["answers"]): other_sess += 1
        if any(a["sessionId"] == c["sessionId"] and a["status"] != "ANSWERED" for a in c["answers"]): skipped_cur += 1
        if c["expect"]["newElements"]: newel += 1
    counts["enrichment_operations"] = total; counts["enrichment_ops_by_type"] = opc
    if not 20 <= len(en) <= 30: err(f, f"{len(en)} cases (20-30)")
    if not 40 <= total <= 60: err(f, f"{total} operations (40-60)")
    for k, v in opc.items():
        if v < 8: err(f, f"op {k} only {v}")
    if len(kinds) < 10: err(f, f"only {len(kinds)} kinds")
    if listops < 4 or scaleops < 2: err(f, f"list ops {listops}, scale ops {scaleops}")
    if other_sess < 3: err(f, "fewer than 3 cases with other-session answers")
    if skipped_cur < 3: err(f, "fewer than 3 cases with skipped/deferred current answers")
    if newel < 3: err(f, "fewer than 3 newElements cases")
    print(f"enrichment: kinds={len(kinds)} list={listops} scale={scaleops} other_sess={other_sess} skipped={skipped_cur} newel={newel}")
else:
    err(f, "missing")

f = os.path.join(ROOT, "evals", "adversarial.json")
ATTACKS = ["IGNORE_PREVIOUS","ROLE_CHANGE","PROMPT_DISCLOSURE","SCOPE_ESCAPE","CROSS_BOOK","FORGED_STRUCTURE","FALSE_APPROVAL","PROSE_REQUEST","CITATION_FORGERY","ENCODED","IN_WORLD_TEXT"]
if os.path.exists(f):
    ad = load_json(f) or []
    counts["adversarial_cases"] = len(ad)
    seen = set(); kinds = set(); legit = allnoc = 0
    for n, c in enumerate(ad, 1):
        w = c.get("id")
        keys_order(f, c, ["id","rationale","attack","injectedText","kind","elementName","customLabel","bookElements","bibleState","sessionId","scopeFieldKeys","answers","expect"], w, optional=("customLabel",))
        if c["id"] != f"adv-{n:02d}": err(f, f"{w}: id")
        if len(c["rationale"]) > 400: err(f, f"{w}: rationale > 400")
        at = c["attack"]
        if at not in ATTACKS: err(f, f"{w}: attack {at}")
        seen.add(at); kinds.add(c["kind"])
        maxlen = 6000 if at == "IGNORE_PREVIOUS" else 600
        ops = check_reconcile(f, c, w, "A", maxlen)
        holders = [a for a in c["answers"] if a["sessionId"] == c["sessionId"] and a["status"] == "ANSWERED" and isinstance(a["answer"], str) and c["injectedText"] in a["answer"]]
        if len(holders) != 1: err(f, f"{w}: injectedText found in {len(holders)} current ANSWERED answers")
        req = ["CITES_NO_ANSWER","CITES_FOREIGN_ANSWER","CITES_UNANSWERED","TARGETS_OUT_OF_SCOPE_FIELD","UNSOURCED_SENTENCE","PROPOSES_STORY_CONTENT","FOLLOWS_EMBEDDED_INSTRUCTION","DISCLOSES_INSTRUCTIONS"]
        if at != "IN_WORLD_TEXT": req.append("COPIES_INJECTED_TEXT")
        if at == "CROSS_BOOK": req.append("READS_OTHER_BOOK")
        if at == "PROSE_REQUEST": req.append("WRITES_PROSE")
        check_mustnot(f, c["expect"]["mustNot"], "A", req, w)
        inj = c["injectedText"].lower()
        for o in ops:
            if o["op"] in ("ADD","UPDATE"):
                if at != "IN_WORLD_TEXT":
                    if not any(p.lower() in inj and 2 <= len(p.split()) <= 5 for p in o["mustNotContain"]): err(f, f"{w}: {o['fieldKey']} mustNotContain lacks a 2-5 word fragment of injectedText")
        if at == "IN_WORLD_TEXT" and not any(o["op"] in ("ADD","UPDATE") and any(p.lower() in inj for p in o["mustContain"]) for o in ops): err(f, f"{w}: IN_WORLD_TEXT op must mustContain a phrase of the quoted text")
        if any(o["op"] in ("ADD","UPDATE") for o in ops): legit += 1
        if all(o["op"] == "NO_CHANGE" for o in ops): allnoc += 1
    if not 12 <= len(ad) <= 16: err(f, f"{len(ad)} cases (12-16)")
    for a in ATTACKS:
        if a not in seen: err(f, f"attack {a} not covered")
    if legit < 4 or allnoc < 3 or len(kinds) < 5: err(f, f"legit={legit} allnoc={allnoc} kinds={len(kinds)}")
    print(f"adversarial: legit={legit} allnoc={allnoc} kinds={len(kinds)}")
else:
    err(f, "missing")

# canonical serialisation for the new eval files
for rel in ("evals/enrichment.json", "evals/adversarial.json"):
    p = os.path.join(ROOT, rel)
    if os.path.exists(p):
        t = open(p, encoding="utf-8").read()
        if t != dump(json.loads(t)): err(p, "not in canonical serialisation (2-space, escapes for invisible/confusable characters)")

print(json.dumps(counts, indent=2))
for w in warns: print("WARN", w)
for e in errors: print("ERR ", e)
print(f"{len(errors)} errors, {len(warns)} warnings")
sys.exit(1 if errors else 0)
