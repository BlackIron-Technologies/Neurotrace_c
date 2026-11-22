"""Yjs-compatible text updates for memory content."""
import base64
from difflib import SequenceMatcher

from pycrdt import Doc, Text


def load_document(state=None):
    doc = Doc({"text": Text()})
    if state:
        doc.apply_update(base64.b64decode(state, validate=True))
    return doc


def encode_document(doc):
    return base64.b64encode(doc.get_update()).decode("ascii")


def replace_text(state, value):
    """Express a text edit as changes to the characters observed by this client."""
    doc = load_document(state)
    text = doc["text"]
    previous = str(text)
    vector = doc.get_state()
    with doc.transaction():
        for tag, start, end, j, k in reversed(SequenceMatcher(None, previous, value, autojunk=False).get_opcodes()):
            if tag == "equal":
                continue
            # Yrs indexes text by UTF-8 byte offset.
            offset = len(previous[:start].encode("utf-8"))
            stop = len(previous[:end].encode("utf-8"))
            if stop > offset:
                del text[offset:stop]
            if k > j:
                text.insert(offset, value[j:k])
    update = base64.b64encode(doc.get_update(vector)).decode("ascii")
    return encode_document(doc), update, str(text)


def merge_text(state, update):
    doc = load_document(state)
    doc.apply_update(base64.b64decode(update, validate=True))
    if set(doc.keys()) != {"text"}:
        raise ValueError("Only the memory text may be changed through CRDT updates")
    return encode_document(doc), str(doc["text"])
