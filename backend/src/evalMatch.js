// Answer scoring for the eval harness. Extracted out of eval.js so it can be
// unit-tested - eval.js runs main() on import and cannot be imported by a test.
//
// An `expect` entry is a list of requirements, ALL of which must hold:
//
//   "nintendo"                substring, case-insensitive
//   ["kennedy", "jfk"]        any-of, substring
//   {"word": "no"}            word-boundary match; array = any-of
//   {"not": <any form>}       must NOT hold
//   {"first": ["a", "b"]}     a's first word-boundary occurrence precedes b's;
//                             b absent = pass, a absent = fail
//
// The last two exist for comparative questions, which the multi-hop memory set
// is full of: "Natural gas grew faster than nuclear" and "Nuclear grew faster
// than natural gas" contain identical substrings, so substring matching scores
// both the same and a green result would mean nothing.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordIndex(hay, needle) {
  const m = new RegExp(`\\b${escapeRegex(needle)}\\b`, "i").exec(hay);
  return m ? m.index : -1;
}

function requirementHolds(hay, req) {
  if (Array.isArray(req)) return req.some((alt) => hay.includes(String(alt).toLowerCase()));
  if (req && typeof req === "object") {
    if ("not" in req) return !requirementHolds(hay, req.not);
    if ("word" in req) {
      const alts = Array.isArray(req.word) ? req.word : [req.word];
      return alts.some((alt) => wordIndex(hay, alt) !== -1);
    }
    if ("first" in req) {
      const [a, b] = req.first;
      const ia = wordIndex(hay, a);
      if (ia === -1) return false;
      const ib = wordIndex(hay, b);
      return ib === -1 || ia < ib;
    }
    return false;
  }
  return hay.includes(String(req).toLowerCase());
}

// Returns null when the question is not scored - deliberately distinct from
// false. Two questions in the shipped set have no establishable ground truth
// and must not be counted either way.
export function matchesExpect(answer, q) {
  if (q.scored === false || !q.expect || !q.expect.length) return null;
  const hay = String(answer ?? "").toLowerCase();
  if (!hay) return false;
  return q.expect.every((req) => requirementHolds(hay, req));
}
