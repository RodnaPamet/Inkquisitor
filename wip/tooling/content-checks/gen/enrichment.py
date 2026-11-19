import sys
sys.path.insert(0, sys.path[0])
from common import *

CASES = []
def case(rat, kind, name, book, bs, sid, scope, answers, ops, newel=(), extra=(), label=None):
    c = {"id": f"en-{len(CASES)+1:02d}", "rationale": rat, "kind": kind, "elementName": name}
    if label: c["customLabel"] = label
    c["bookElements"] = [{"kind": k, "name": n} for k, n in book]
    c["bibleState"] = bs; c["sessionId"] = sid; c["scopeFieldKeys"] = scope; c["answers"] = answers
    c["expect"] = {"operations": ops, "newElements": [{"kind": k, "name": n, "cites": ci} for k, n, ci in newel], "mustNot": BASE + [x for x in extra if x not in BASE]}
    CASES.append(c)

# 01 CHARACTER: ADD into empty want; UPDATE wound that the answer contradicts
case("ADD into an empty want, and an UPDATE where the author contradicts the stored wound: the mother stayed and the father left. The new wound must drop the retracted fact rather than merge both versions, and must not add a motive or feeling the answer does not give.",
 "CHARACTER", "Wren Halloway", [("CHARACTER", "Wren Halloway"), ("SETTING", "Saltmarsh")],
 {"role": "Protagonist. Runs the ferry office in a shrinking marsh town.", "want": None, "wound": "Her mother left the family when Wren was nine.", "false_belief": None, "need": None, "arc": None},
 "s2", ["want", "wound"],
 [ans("a1", "s2", "OPEN", "What does Wren want, in words she would use herself?", ["want"], "ANSWERED", "She wants to win back the seat on the town council that she lost to her brother."),
  ans("a2", "s2", "OPEN", "How does the hurt you have stored still shape what Wren does?", ["wound"], "ANSWERED", "Actually I've changed that. Her mother stayed. It was her father who walked out, the winter she turned nine, and she has never forgiven him.")],
 [op("want", "ADD", ["a1"], ["council"], ["revenge"], "To win back the seat on the town council that she lost to her brother."),
  op("wound", "UPDATE", ["a2"], ["father"], ["mother left"], "Her father walked out the winter she turned nine, and she has never forgiven him.")])

# 02 PLOT: list UPDATE appending; SKIPPED climax; named entity already in book
case("An UPDATE that appends a third complication to a stored list, keeping the two already there, and a SKIPPED climax that must stay NO_CHANGE. The harbour master the answer names is already a book element, so no new element is proposed.",
 "PLOT", "The salvage claim", [("PLOT", "The salvage claim"), ("CHARACTER", "Ruud Delaney"), ("CHARACTER", "Ma Corrigan")],
 {"plotline_owner": "Ma Corrigan, who runs the salvage yard.", "opening_disturbance": "A sunk trawler surfaces in the bay with its hold still sealed.", "driving_goal": "Win the salvage rights before the insurers arrive.",
  "complications": ["A rival yard files its claim first.", "Her diver refuses to go down after the first dive."], "climax": None, "resolution": None},
 "s3", ["complications", "climax"],
 [ans("a1", "s3", "OPEN", "What else stands between Ma Corrigan and the salvage rights?", ["complications"], "ANSWERED", "Add a third one after those two: the harbour master, Ruud Delaney, impounds her boat for unpaid mooring fees."),
  ans("a2", "s3", "OPEN", "Where does this plotline come to its decisive confrontation?", ["climax"], "SKIPPED", None)],
 [op("complications", "UPDATE", ["a1"], ["Ruud Delaney", "impounds"], ["bribe"], ["A rival yard files its claim first.", "Her diver refuses to go down after the first dive.", "The harbour master, Ruud Delaney, impounds her boat for unpaid mooring fees."]),
  N("climax")], extra=["INVENTS_NEW_ELEMENT", "CITES_UNANSWERED"])

# 03 SETTING: one answer touching two fields; a new character named
case("One answer fills two empty fields: the sensory signature and why the story needs the place. It also names Ilse, who is not yet a book element, so a new character is proposed; Tomas already exists and must not be proposed again.",
 "SETTING", "The tannery yard", [("SETTING", "The tannery yard"), ("CHARACTER", "Tomas")],
 {"place_type": "A walled tannery yard at the edge of a river town, closed at night.", "sensory_signature": None, "story_purpose": None, "pressure_on_characters": None},
 "s1", ["sensory_signature", "story_purpose"],
 [ans("a1", "s1", "OPEN", "What is it like to be in the tannery yard, and why does the story need it?", ["sensory_signature", "story_purpose"], "ANSWERED", "It stinks of lime and old hides, and the vats hiss when it rains. The book needs it because it is the one place where Tomas and Ilse can meet without being seen.")],
 [op("sensory_signature", "ADD", ["a1"], ["lime", "hides", "vats hiss"], ["rats"], "It stinks of lime and old hides, and the vats hiss when it rains."),
  op("story_purpose", "ADD", ["a1"], ["Tomas", "Ilse"], ["lovers"], "The one place where Tomas and Ilse can meet without being seen.")],
 newel=[("CHARACTER", "Ilse", ["a1"])], extra=["OMITS_NEW_ELEMENT", "INVENTS_NEW_ELEMENT"])

# 04 THEME: vague -> NO_CHANGE; list UPDATE removing an item
case("A vague reply about the counter-argument must yield NO_CHANGE rather than a guessed one. The carriers reply removes one item and confirms two, so the list is UPDATED without the orchard. Writing 'duty' into the counter-argument is the tempting mistake.",
 "THEME", "What we are left", [("THEME", "What we are left"), ("CHARACTER", "Agathe Wolde")],
 {"subject": "What an inheritance asks of the people who receive it.", "thematic_question": "Is accepting an inheritance a debt to the dead or a theft from the living?", "stance": "The book comes down on debt: the sisters keep the house and pay for it.",
  "counter_argument": None, "carriers": ["The two sisters", "The unsigned will", "The orchard"]},
 "s2", ["counter_argument", "carriers"],
 [ans("a1", "s2", "OPEN", "What is the strongest case against the reply your book gives?", ["counter_argument"], "ANSWERED", "Not sure. Maybe something about duty? I'd have to think about it."),
  ans("a2", "s2", "OPEN", "Which characters, events or images carry this theme?", ["carriers"], "ANSWERED", "Take the orchard out, I cut those chapters. The two sisters and the unsigned will still carry it.")],
 [N("counter_argument"),
  op("carriers", "UPDATE", ["a2"], ["two sisters", "unsigned will"], ["orchard"], ["The two sisters", "The unsigned will"])])

# 05 MOOD: scale UPDATE, list ADD, an earlier-session answer that must not be cited
case("A scale UPDATE from 4 to 2 and a list ADD of one mood shift. a3 comes from an earlier session and is already folded into the closing feeling; citing it, or touching the closing feeling at all, is wrong.",
 "MOOD", "Book-wide mood", [("MOOD", "Book-wide mood")],
 {"dominant_feeling": "A low, patient unease.", "intensity": 4, "mood_shifts": None, "closing_feeling": "Tired relief."},
 "s2", ["intensity", "mood_shifts"],
 [ans("a3", "s1", "OPEN", "What should a reader feel as they close the book?", ["closing_feeling"], "ANSWERED", "Tired relief, like after a long night shift."),
  ans("a1", "s2", "SCALE", "How hard should the unease press on the reader?", ["intensity"], "ANSWERED", 2, scale={"low": "restrained", "high": "overwhelming"}),
  ans("a2", "s2", "OPEN", "Where should the feeling deliberately change, and to what?", ["mood_shifts"], "ANSWERED", "It lifts once, at the wedding in chapter twelve, into something almost giddy, and then drops back.")],
 [op("intensity", "UPDATE", ["a1"], ["2"], [], 2),
  op("mood_shifts", "ADD", ["a2"], ["wedding", "giddy"], ["funeral"], ["At the wedding in chapter twelve the unease lifts into something almost giddy, then drops back."])],
 extra=["CITES_FOREIGN_ANSWER"])

# 06 TEXTURE: scale UPDATE, list ADD
case("A scale UPDATE (density 2 to 4) and a motifs ADD naming two recurring images with the meaning the author gives them. The proposal must not add a third motif or a meaning beyond 'the house is still alive'.",
 "TEXTURE", "Book-wide texture", [("TEXTURE", "Book-wide texture"), ("SETTING", "Calder House")],
 {"sensory_emphasis": "Sound first, then touch.", "detail_density": 2, "recurring_details": ["A cracked teacup on the dresser", "Swifts nesting under the eaves", "The clock that runs ten minutes slow"], "motifs": None},
 "s4", ["detail_density", "motifs"],
 [ans("a1", "s4", "SCALE", "How much concrete detail should the page carry?", ["detail_density"], "ANSWERED", 4, scale={"low": "sparse", "high": "lush"}),
  ans("a2", "s4", "OPEN", "Which of your recurring details should gather meaning as they return?", ["motifs"], "ANSWERED", "The cracked teacup and the swifts. Every time they come back they should say the house is still alive.")],
 [op("detail_density", "UPDATE", ["a1"], ["4"], [], 4),
  op("motifs", "ADD", ["a2"], ["cracked teacup", "swifts"], ["clock"], ["The cracked teacup: the house is still alive", "The swifts: the house is still alive"])])

# 07 STYLE: UPDATE contradicting tense; explicit retraction -> REMOVE
case("The author reverses the tense (UPDATE, dropping 'past tense throughout' but keeping the letters in past tense) and explicitly retracts the dialogue conventions with nothing in their place (REMOVE). Proposing a replacement convention is the tempting mistake.",
 "STYLE", "Prose style", [("STYLE", "Prose style")],
 {"tense": "Past tense throughout.", "diction": "Plain, concrete, few Latinate words.", "sentence_rhythm": None, "dialogue_conventions": "Single quotation marks, 'said' only, tags after the first clause.", "spelling_variant": "British English."},
 "s2", ["tense", "dialogue_conventions"],
 [ans("a1", "s2", "OPEN", "Does the stored tense still hold, and are there exceptions?", ["tense"], "ANSWERED", "I've changed my mind: present tense, except the letters between the sisters, which stay in the past tense."),
  ans("a2", "s2", "OPEN", "How should speech be set out and tagged?", ["dialogue_conventions"], "ANSWERED", "Scrap what I said about dialogue. I don't want any fixed rule written down for it yet.")],
 [op("tense", "UPDATE", ["a1"], ["present tense", "letters"], ["past tense throughout"], "Present tense, except the letters between the sisters, which stay in the past tense."),
  R("dialogue_conventions", ["a2"])])

# 08 POV: one answer -> UPDATE list and REMOVE switching pattern
case("One answer touches two fields: Joss is dropped as a viewpoint (list UPDATE to Mara alone) and the author explicitly asks for the alternating-chapters note to go (REMOVE). Mara and Joss are existing elements; no new element.",
 "POV", "Narration", [("POV", "Narration"), ("CHARACTER", "Mara"), ("CHARACTER", "Joss")],
 {"viewpoint_characters": ["Mara", "Joss"], "person": "Close third person.", "narrative_distance": 4, "knowledge_limits": "Each chapter knows only what its viewpoint character knows.", "switching_pattern": "Alternates every chapter between Mara and Joss."},
 "s4", ["viewpoint_characters", "switching_pattern"],
 [ans("a1", "s4", "OPEN", "Whose perspective does the narration follow now?", ["viewpoint_characters", "switching_pattern"], "ANSWERED", "Joss is out as a viewpoint; it's Mara's book alone. So delete the alternating-chapters note too, there's no switching left to describe.")],
 [op("viewpoint_characters", "UPDATE", ["a1"], ["Mara"], ["Joss"], ["Mara"]),
  R("switching_pattern", ["a1"])], extra=["INVENTS_NEW_ELEMENT"])

# 09 WORLD_RULE: UPDATE extending a stored cost; DECIDE_LATER -> NO_CHANGE
case("The answer adds a limit on top of the stored cost, so the UPDATE keeps the existing cost and adds the new limit. who_knows was deferred this session and stays NO_CHANGE; inventing who knows is the tempting mistake.",
 "WORLD_RULE", "Tide-binding", [("WORLD_RULE", "Tide-binding")],
 {"rule_statement": "A binder can hold a ship still on any tide by speaking its true name.", "domain": "Magic.", "cost_or_limit": "Each binding takes a year from the binder's life.", "who_knows": None, "story_consequence": None},
 "s2", ["cost_or_limit", "who_knows"],
 [ans("a1", "s2", "OPEN", "Where does tide-binding stop working, beyond the cost you have stored?", ["cost_or_limit"], "ANSWERED", "On top of the year it costs, it only works within sight of the sea. Inland it does nothing at all."),
  ans("a2", "s2", "CHOICE", "How widely is tide-binding understood?", ["who_knows"], "DECIDE_LATER", None, options=["known to everyone", "known to a trained few", "known to one family", "known to no one living"])],
 [op("cost_or_limit", "UPDATE", ["a1"], ["within sight of the sea"], ["moon"], "Each binding takes a year from the binder's life, and it only works within sight of the sea; inland it does nothing."),
  N("who_knows")], extra=["CITES_UNANSWERED"])

# 10 TIMELINE_EVENT: one answer -> two ADDs and two new characters
case("One answer gives both when the fire happens and who was present. Piet and Arend Klaas are not book elements and are proposed as new characters; Sunniva already exists. The participants list holds exactly the three people named.",
 "TIMELINE_EVENT", "The mill fire", [("TIMELINE_EVENT", "The mill fire"), ("CHARACTER", "Sunniva")],
 {"what_happens": "The old flour mill burns to the ground overnight.", "story_time": None, "participants": None, "consequences": "The village loses its only employer, and Sunniva's family is blamed."},
 "s3", ["story_time", "participants"],
 [ans("a1", "s3", "OPEN", "When does the fire happen, and who is there?", ["story_time", "participants"], "ANSWERED", "It happens the night before Sunniva's wedding, and the only people there are Sunniva, her uncle Piet and the night watchman, Arend Klaas.")],
 [op("story_time", "ADD", ["a1"], ["night before", "wedding"], [], "The night before Sunniva's wedding."),
  op("participants", "ADD", ["a1"], ["Sunniva", "Piet", "Arend Klaas"], ["fire brigade"], ["Sunniva", "Piet, her uncle", "Arend Klaas, the night watchman"])],
 newel=[("CHARACTER", "Piet", ["a1"]), ("CHARACTER", "Arend Klaas", ["a1"])], extra=["OMITS_NEW_ELEMENT", "INVENTS_NEW_ELEMENT"])

# 11 FACTION: ADD, volunteered out-of-scope detail, explicit retraction
case("ADD the internal tension; the same answer volunteers a detail about the leader's key, which is outside scope and yields no operation. The author withdraws the faction's side in the conflict and leaves it blank: REMOVE, with no replacement side.",
 "FACTION", "The Wardens of the Weir", [("FACTION", "The Wardens of the Weir"), ("CHARACTER", "The Duke of Marrow")],
 {"purpose": "To keep the weir gates working and decide when the lowlands flood.", "membership": "Hereditary; a seat passes to the eldest child.", "power_base": "They alone hold the keys to the weir gates.",
  "internal_tension": None, "role_in_conflict": "They side with the Duke of Marrow against the lowland farmers."},
 "s2", ["internal_tension", "role_in_conflict"],
 [ans("a1", "s2", "OPEN", "Where do the Wardens disagree among themselves?", ["internal_tension"], "ANSWERED", "The old families resent the newcomers who now outnumber them on the council. And by the way, their leader always carries a silver key on a chain."),
  ans("a2", "s2", "OPEN", "Where do the Wardens stand in the central conflict?", ["role_in_conflict"], "ANSWERED", "I'm withdrawing what I said about them siding with the duke. Leave it blank until I know.")],
 [op("internal_tension", "ADD", ["a1"], ["old families", "newcomers"], ["silver key"], "The old families resent the newcomers who now outnumber them on the council."),
  R("role_in_conflict", ["a2"])], extra=["INVENTS_NEW_ELEMENT"])

# 12 OBJECT: confirmation -> NO_CHANGE; ADD origin; existing named element
case("The holder reply only confirms the stored value, so NO_CHANGE. The origin is ADDED from a2. Brother Anselm is already a book element, so newElements stays empty; proposing him again is wrong.",
 "OBJECT", "The pilgrim's bell", [("OBJECT", "The pilgrim's bell"), ("CHARACTER", "Brother Anselm")],
 {"physical_description": "A hand bell of dark iron, its clapper bound in leather.", "current_holder": "Brother Anselm keeps it in the chapel.", "origin": None, "significance": "Whoever rings it may claim sanctuary."},
 "s1", ["current_holder", "origin"],
 [ans("a1", "s1", "OPEN", "Who has the bell when the story opens?", ["current_holder"], "ANSWERED", "Same as before, it's with Brother Anselm in the chapel."),
  ans("a2", "s1", "OPEN", "Where did the bell come from?", ["origin"], "ANSWERED", "It was cast from the melted chains of the old prison when the prison was pulled down.")],
 [N("current_holder"),
  op("origin", "ADD", ["a2"], ["melted chains", "old prison"], ["blessed"], "Cast from the melted chains of the old prison when the prison was pulled down.")],
 extra=["INVENTS_NEW_ELEMENT"])

# 13 RESEARCH: REMOVE an open question that is now settled; ADD sources; volunteered fact out of scope
case("The only open question is now settled and the author has no others, so REMOVE. The settled fact itself belongs to established_facts, which is outside scope: no operation there. Sources are ADDED. The interviewer must not add facts about telegraphy.",
 "RESEARCH", "Victorian telegraphy", [("RESEARCH", "Victorian telegraphy")],
 {"topic": "How a provincial telegraph office worked in the 1880s.", "why_needed": "The middle third turns on a telegram sent at night.", "established_facts": ["Messages were charged by the word (operator's handbook)."], "open_questions": ["Did offices charge a different rate at night?"], "sources": None},
 "s3", ["open_questions", "sources"],
 [ans("a1", "s3", "OPEN", "What is still unknown or unchecked?", ["open_questions"], "ANSWERED", "I've settled the night-rate question: I found a tariff card at the postal museum, and there was a night rate. So that comes off, and I have no other open questions right now."),
  ans("a2", "s3", "OPEN", "Which books, people, places or records have you consulted?", ["sources"], "ANSWERED", "The tariff card at the postal museum, and my great-uncle's operator's handbook.")],
 [R("open_questions", ["a1"]),
  op("sources", "ADD", ["a2"], ["tariff card", "operator's handbook"], ["national archive"], ["Tariff card, postal museum", "Great-uncle's operator's handbook"])])

# 14 CUSTOM: noncommittal -> NO_CHANGE; REMOVE the only open question
case("A noncommittal reply on key details is NO_CHANGE. The author strikes the only open question because the thread is gone from the book: REMOVE. Adding a new open question, or noting the cellar door in key details, is wrong.",
 "CUSTOM", "The debt ledger", [("CUSTOM", "The debt ledger")],
 {"purpose": "A ledger of favours owed between three families, quoted at the head of each part.", "key_details": ["Only the grandmother writes in it.", "A debt is never cancelled, only repaid in kind."],
  "connections": None, "open_questions": ["Who first wrote in the ledger behind the cellar door?"]},
 "s2", ["key_details", "open_questions"],
 [ans("a1", "s2", "OPEN", "Which other detail of the ledger must never vary?", ["key_details"], "ANSWERED", "Hmm, I'm not sure there is anything else. It's fine as it is, I think."),
  ans("a2", "s2", "OPEN", "What about the ledger have you still to decide?", ["open_questions"], "ANSWERED", "Strike that question about the cellar door. I've let that thread go entirely; it isn't in the book any more.")],
 [N("key_details"), R("open_questions", ["a2"])], label="Family ledger")

# 15 PREMISE: ADD stakes; vague story question; earlier-session answer
case("Stakes are ADDED from a1. The story-question reply hands the decision back ('whatever the obvious one is'), which tempts the model to write one: NO_CHANGE. a3 is an earlier session's answer already in central_conflict and must not be cited.",
 "PREMISE", "The ninth lock", [("PREMISE", "The ninth lock"), ("SETTING", "The Arle valley")],
 {"central_character": "A lock-keeper's daughter who has never left the valley.", "starting_situation": "She has kept the ninth lock alone since her father died last winter.", "central_conflict": "The water board will open the dam above the valley in a month, and only she knows the lock gates cannot hold.", "stakes": None, "story_question": None},
 "s2", ["stakes", "story_question"],
 [ans("a3", "s1", "OPEN", "What opposes her, and why can she not walk away?", ["central_conflict"], "ANSWERED", "The water board will open the dam in a month, and only she knows the lock gates won't hold."),
  ans("a1", "s2", "OPEN", "What is lost if she fails?", ["stakes"], "ANSWERED", "If she fails, the valley floods, and her father's grave goes under with it."),
  ans("a2", "s2", "OPEN", "What question will keep a reader turning the pages?", ["story_question"], "ANSWERED", "I don't really know. Whatever the obvious one is.")],
 [op("stakes", "ADD", ["a1"], ["valley floods", "father's grave"], ["village dies"], "The valley floods, and her father's grave goes under with it."),
  N("story_question")], extra=["CITES_FOREIGN_ANSWER"])

# 16 CHARACTER: explicit retraction -> REMOVE; SKIPPED need
case("The author scraps the stored false belief and leaves it empty while rethinking: REMOVE, no replacement belief. The need was skipped: NO_CHANGE. Writing the opposite belief into the field is the tempting mistake.",
 "CHARACTER", "Old Hesketh", [("CHARACTER", "Old Hesketh")],
 {"role": "The protagonist's grandfather, who raised her.", "want": "To see the farm pass to someone of his blood.", "wound": "He lost his own farm to the bank as a young man.", "false_belief": "He believes no one could love him for himself.", "need": None, "arc": None},
 "s3", ["false_belief", "need"],
 [ans("a1", "s3", "OPEN", "Does the false belief you have stored still fit him?", ["false_belief"], "ANSWERED", "Scrap the belief I gave him. He doesn't think he's unlovable after all. I'm leaving it empty while I rethink him."),
  ans("a2", "s3", "OPEN", "What does Hesketh actually lack, beneath what he wants?", ["need"], "SKIPPED", None)],
 [R("false_belief", ["a1"]), N("need")], extra=["CITES_UNANSWERED"])

# 17 SETTING: two UPDATEs extending stored values
case("Both answers extend what is stored: two new sensory details, and a second source of pressure beside the cold. Each UPDATE keeps the stored content and adds the new; replacing the cold or inventing a feud is wrong.",
 "SETTING", "Kestrel Station", [("SETTING", "Kestrel Station")],
 {"place_type": "A research station on a sub-Antarctic island, eleven people over winter.", "sensory_signature": "Wind against the cladding, and the white glare off the snow.", "story_purpose": "It traps the characters together for the whole book.", "pressure_on_characters": "The cold keeps everyone indoors and short-tempered."},
 "s2", ["sensory_signature", "pressure_on_characters"],
 [ans("a1", "s2", "OPEN", "What else would someone notice inside the station?", ["sensory_signature"], "ANSWERED", "Add the generator hum, which never stops, and the smell of diesel in every corridor."),
  ans("a2", "s2", "OPEN", "How else does the station press on the people in it?", ["pressure_on_characters"], "ANSWERED", "The isolation strips them of excuses: nobody can leave until the supply ship in spring, so every grudge has to be lived with.")],
 [op("sensory_signature", "UPDATE", ["a1"], ["generator hum", "diesel"], ["seals"], "Wind against the cladding, the white glare off the snow, the generator hum that never stops, and the smell of diesel in every corridor."),
  op("pressure_on_characters", "UPDATE", ["a2"], ["supply ship", "grudge"], ["murder"], "The cold keeps everyone indoors and short-tempered, and nobody can leave until the supply ship in spring, so every grudge has to be lived with.")])

# 18 THEME: REMOVE in current session; earlier session set the value
case("The thematic question was set from an earlier session's answer (a1, s1). In this session the author drops it and leaves it open: REMOVE citing a2 only. Citing a1, or writing a new question, is wrong.",
 "THEME", "Whose land", [("THEME", "Whose land")],
 {"subject": "Belonging to a place one was not born in.", "thematic_question": "Can a place belong to people who were born somewhere else?", "stance": None, "counter_argument": None, "carriers": None},
 "s2", ["thematic_question"],
 [ans("a1", "s1", "OPEN", "What question does the book ask about belonging?", ["thematic_question"], "ANSWERED", "Can a place belong to people who were born somewhere else?"),
  ans("a2", "s2", "OPEN", "Does the question you stored still say what the book is asking?", ["thematic_question"], "ANSWERED", "No. Drop that question; it was the wrong one, and I'd rather leave it open for now than replace it.")],
 [R("thematic_question", ["a2"])], extra=["CITES_FOREIGN_ANSWER"])

# 19 MOOD: REMOVE the only listed shift; restated value -> NO_CHANGE
case("The only mood shift listed is at a funeral the author has cut: REMOVE. The closing-feeling reply restates the stored value word for word: NO_CHANGE, not an UPDATE that rewrites it.",
 "MOOD", "Part three", [("MOOD", "Part three")],
 {"dominant_feeling": "Dread that something will be taken.", "intensity": 3, "mood_shifts": ["At the funeral the dread gives way to anger."], "closing_feeling": "Quiet relief."},
 "s5", ["mood_shifts", "closing_feeling"],
 [ans("a1", "s5", "OPEN", "Where does the feeling in part three change, and to what?", ["mood_shifts"], "ANSWERED", "Take out the funeral shift. I've cut the funeral, and there is no shift there now."),
  ans("a2", "s5", "OPEN", "What should a reader feel at the end of part three?", ["closing_feeling"], "ANSWERED", "Exactly what I said before: quiet relief.")],
 [R("mood_shifts", ["a1"]), N("closing_feeling")])

# 20 STYLE: three ADDs from two answers, one answer touching two fields
case("Three empty fields. a1 touches tense and spelling at once; a2 is an either-or whose pick fills diction. The proposed values must hold what was said and nothing more: no rhythm or dialogue rules.",
 "STYLE", "Prose style", [("STYLE", "Prose style")],
 {"tense": None, "diction": None, "sentence_rhythm": None, "dialogue_conventions": None, "spelling_variant": None},
 "s1", ["tense", "diction", "spelling_variant"],
 [ans("a1", "s1", "OPEN", "Which tense will the narration use, and which spelling conventions?", ["tense", "spelling_variant"], "ANSWERED", "Past tense, and American spelling, because the narrator is American and it should read that way."),
  ans("a2", "s1", "EITHER_OR", "Which way does the prose lean in its choice of words?", ["diction"], "ANSWERED", "plain and spare", options=["plain and spare", "rich and ornate"])],
 [op("tense", "ADD", ["a1"], ["past tense"], ["present"], "Past tense."),
  op("diction", "ADD", ["a2"], ["plain and spare"], ["ornate"], "Plain and spare."),
  op("spelling_variant", "ADD", ["a1"], ["American"], ["British"], "American spelling.")])

# 21 POV: ADD with a new character; DECIDE_LATER
case("The viewpoint list is ADDED with Lena, who is not a book element, so a new character is proposed. The grammatical person was deferred: NO_CHANGE, and guessing first or third person is wrong.",
 "POV", "Narration", [("POV", "Narration"), ("SETTING", "The border town")],
 {"viewpoint_characters": None, "person": None, "narrative_distance": None, "knowledge_limits": None, "switching_pattern": None},
 "s1", ["viewpoint_characters", "person"],
 [ans("a1", "s1", "OPEN", "Whose perspective does the narration follow?", ["viewpoint_characters"], "ANSWERED", "Just Lena, the whole way through."),
  ans("a2", "s1", "EITHER_OR", "Is the narration in first person or third?", ["person"], "DECIDE_LATER", None, options=["first person", "third person"])],
 [op("viewpoint_characters", "ADD", ["a1"], ["Lena"], [], ["Lena"]), N("person")],
 newel=[("CHARACTER", "Lena", ["a1"])], extra=["OMITS_NEW_ELEMENT", "CITES_UNANSWERED"])

# 22 WORLD_RULE: one answer, two UPDATEs (statement narrowed, domain changed)
case("One answer moves the rule from law to custom and narrows it to feast nights. Both the statement and the domain are UPDATED; the statement keeps the whisper and the walls and drops 'every night'.",
 "WORLD_RULE", "The quiet rule", [("WORLD_RULE", "The quiet rule"), ("SETTING", "Harrowgate")],
 {"rule_statement": "No one may speak above a whisper inside the city walls after dusk, every night of the year.", "domain": "Law.", "cost_or_limit": "A night in the stocks for anyone heard.", "who_knows": "Everyone in the city.", "story_consequence": "Plots are hatched in sign language after dark."},
 "s3", ["rule_statement", "domain"],
 [ans("a1", "s3", "OPEN", "Does the rule still read as you stored it?", ["rule_statement", "domain"], "ANSWERED", "I've moved it: it's no longer a law but a custom, and it applies only on feast nights, not every night.")],
 [op("rule_statement", "UPDATE", ["a1"], ["feast nights"], ["every night"], "No one speaks above a whisper inside the city walls after dusk on feast nights."),
  op("domain", "UPDATE", ["a1"], ["custom"], [], "Custom.")])

# 23 TIMELINE_EVENT: contradiction UPDATE; ADD consequences; out-of-scope volunteer
case("The date is corrected from spring to October (UPDATE, dropping spring), and consequences are ADDED. The answer also volunteers that the Marsh brothers were not there, which concerns participants, outside scope: no operation on it.",
 "TIMELINE_EVENT", "The flood of '61", [("TIMELINE_EVENT", "The flood of '61"), ("CHARACTER", "Edie"), ("FACTION", "The Marsh brothers")],
 {"what_happens": "The river breaks its banks and drowns the lower village.", "story_time": "Spring 1961.", "participants": ["Edie", "The Marsh brothers"], "consequences": None},
 "s2", ["story_time", "consequences"],
 [ans("a1", "s2", "OPEN", "When exactly does the flood happen?", ["story_time"], "ANSWERED", "It was the autumn, not the spring: October 1961. Oh, and the Marsh brothers weren't actually there that night."),
  ans("a2", "s2", "OPEN", "What changes because of the flood?", ["consequences"], "ANSWERED", "The lower village was never rebuilt; everyone moved up to the ridge.")],
 [op("story_time", "UPDATE", ["a1"], ["October 1961"], ["spring"], "October 1961."),
  op("consequences", "ADD", ["a2"], ["never rebuilt", "ridge"], ["compensation"], "The lower village was never rebuilt; everyone moved up to the ridge.")])

# 24 FACTION: ADD membership; SKIPPED power base
case("Membership is ADDED with both how one joins and how one leaves. The power base was skipped: NO_CHANGE. Inferring leverage from the membership reply is the tempting mistake.",
 "FACTION", "The Lamplighters' Union", [("FACTION", "The Lamplighters' Union")],
 {"purpose": "To keep the city's gas lamps lit and its members paid.", "membership": None, "power_base": None, "internal_tension": None, "role_in_conflict": None},
 "s1", ["membership", "power_base"],
 [ans("a1", "s1", "OPEN", "Who belongs to the union, and how do people join or leave?", ["membership"], "ANSWERED", "Anyone who has lit lamps for a year can join. You leave only by dying."),
  ans("a2", "s1", "OPEN", "What gives the union its leverage?", ["power_base"], "SKIPPED", None)],
 [op("membership", "ADD", ["a1"], ["a year", "dying"], ["guild"], "Anyone who has lit lamps for a year can join; members leave only by dying."), N("power_base")],
 extra=["CITES_UNANSWERED"])

# 25 OBJECT: confirmation -> NO_CHANGE; explicit retraction -> REMOVE
case("The description reply confirms what is stored: NO_CHANGE. The author takes back the stored significance and says not to replace it: REMOVE. Proposing a new reason the eye matters is wrong.",
 "OBJECT", "The glass eye", [("OBJECT", "The glass eye"), ("CHARACTER", "Captain Moss")],
 {"physical_description": "Green glass, with a crack across the iris.", "current_holder": "Captain Moss, who wears it.", "origin": "Made by a lens-grinder in the port town.", "significance": "It is the key to the inheritance: the will is hidden behind it."},
 "s2", ["physical_description", "significance"],
 [ans("a1", "s2", "OPEN", "Is the description you stored still how the eye looks?", ["physical_description"], "ANSWERED", "Yes, that's right: green glass, a crack across the iris."),
  ans("a2", "s2", "OPEN", "Why does the eye matter to the story?", ["significance"], "ANSWERED", "I no longer think it matters to the plot at all. Take out what I wrote about it being the key to the inheritance, and don't replace it.")],
 [N("physical_description"), R("significance", ["a2"])])

# 26 RESEARCH: three ADDs, one answer touching two fields
case("a1 fills both an established fact and its source; a2 fills why the topic is needed. The fact must keep its provenance and must not be expanded with anything the author did not state about lighthouses.",
 "RESEARCH", "Lighthouse lenses", [("RESEARCH", "Lighthouse lenses")],
 {"topic": "How a first-order lighthouse lens was turned and kept lit in the 1900s.", "why_needed": None, "established_facts": None, "open_questions": None, "sources": None},
 "s1", ["why_needed", "established_facts", "sources"],
 [ans("a1", "s1", "OPEN", "What have you settled so far, and where did it come from?", ["established_facts", "sources"], "ANSWERED", "From the keeper's manual at the county archive: the lens turned on a bath of mercury."),
  ans("a2", "s1", "OPEN", "Which part of your book depends on getting this right?", ["why_needed"], "ANSWERED", "The climax happens in the lamp room, so I need to know how it worked.")],
 [op("why_needed", "ADD", ["a2"], ["lamp room", "climax"], [], "The climax happens in the lamp room."),
  op("established_facts", "ADD", ["a1"], ["bath of mercury", "keeper's manual"], ["clockwork"], ["The lens turned on a bath of mercury (keeper's manual, county archive)."]),
  op("sources", "ADD", ["a1"], ["keeper's manual", "county archive"], [], ["Keeper's manual, county archive"])])

# 27 CUSTOM: list ADD; UPDATE narrowing connections
case("Key details are ADDED as two items. The connections are revised to the kitchen chapters only: UPDATE that drops the wedding rather than keeping both.",
 "CUSTOM", "The ghost recipe", [("CUSTOM", "The ghost recipe")],
 {"purpose": "A family recipe the women of the house cook at every turning point.", "key_details": None, "connections": "It appears in the kitchen chapters and again at the wedding feast.", "open_questions": None},
 "s3", ["key_details", "connections"],
 [ans("a1", "s3", "OPEN", "Which details of the recipe must never vary?", ["key_details"], "ANSWERED", "It always has exactly seven ingredients, and it is never written down."),
  ans("a2", "s3", "OPEN", "Does the recipe still touch the parts of the book you stored?", ["connections"], "ANSWERED", "I've rethought where it appears: it now turns up only in the three kitchen chapters, not at the wedding.")],
 [op("key_details", "ADD", ["a1"], ["seven ingredients", "never written down"], ["saffron"], ["Exactly seven ingredients", "Never written down"]),
  op("connections", "UPDATE", ["a2"], ["kitchen chapters"], ["wedding"], "It appears only in the three kitchen chapters.")], label="Recurring recipe")

open(sys.argv[1], "w", encoding="utf-8").write(dump(CASES))
