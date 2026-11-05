/*
 * Matching rules shared by the Node server and the serverless transport, so both behave identically.
 * Preferences (interests, language) are soft: after SOFT_WAIT_MS of waiting they stop mattering,
 * so nobody is left waiting forever for a perfect match. Mode and private room are hard rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MatchRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SOFT_WAIT_MS = 8000;
  const MAX_INTERESTS = 5;

  function normInterests(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const v = raw.toLowerCase().replace(/[^\p{L}\p{N} +#-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (v && !out.includes(v)) out.push(v);
      if (out.length >= MAX_INTERESTS) break;
    }
    return out;
  }
  const normLang = (v) => (typeof v === 'string' && /^[a-z]{2,3}$/i.test(v) ? v.toLowerCase() : 'any');
  const normRoom = (v) => (typeof v === 'string' && /^[a-z0-9]{4,24}$/i.test(v) ? v.toLowerCase() : '');
  const normAvoid = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, 50) : []);

  const shared = (a, b) => a.interests.filter((i) => b.interests.includes(i)).length;

  /** a and b: { mode, room, interests[], lang, waited } (waited in ms) */
  function compatible(a, b, softMs = SOFT_WAIT_MS) {
    if (a.mode !== b.mode || a.room !== b.room) return false;
    if (Math.max(a.waited || 0, b.waited || 0) >= softMs) return true;
    const interestsOk = !a.interests.length || !b.interests.length || shared(a, b) > 0;
    const langOk = a.lang === 'any' || b.lang === 'any' || a.lang === b.lang;
    return interestsOk && langOk;
  }

  const score = (a, b) => shared(a, b) * 2 + (a.lang !== 'any' && a.lang === b.lang ? 1 : 0);

  return { SOFT_WAIT_MS, MAX_INTERESTS, normInterests, normLang, normRoom, normAvoid, compatible, score, shared };
}));
