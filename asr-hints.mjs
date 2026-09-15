/** Build source-language ASR hints without treating glossary translations as audio. */
export function asrVocabulary(glossary, weight) {
  if (!Number.isInteger(weight) || weight < 1 || weight > 5) throw new RangeError('ASR hint weight must be an integer from 1 to 5.');
  const entries = [], seen = new Set();
  for (const line of String(glossary || '').split(/\r\n?|\n/)) {
    // A definition owns the whole line. Its translated text and annotations
    // may contain commas, semicolons and further equals signs; discard all of
    // them before considering the separators supported by plain word lists.
    const separator = line.search(/=>|→|=|：|:/);
    const candidates = separator >= 0 ? [line.slice(0, separator)] : line.split(/[,;，；、]+/);
    for (const candidate of candidates) {
      const term = candidate.trim().slice(0, 100);
      const identity = term.toLowerCase();
      if (!term || seen.has(identity)) continue;
      seen.add(identity); entries.push([term, weight]);
      if (entries.length === 100) return Object.fromEntries(entries);
    }
  }
  // Object.fromEntries defines own data properties, including __proto__, rather
  // than invoking the prototype setter through dictionary[key] assignment.
  return Object.fromEntries(entries);
}
