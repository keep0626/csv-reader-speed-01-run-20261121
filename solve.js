// Fast CSV reader: a drop-in for csv-reader 1.0.0 with identical answers.
//
// Strategy: never build a field one character at a time. Quoted fields are
// cut out with slice() after a native indexOf('"') jump finds their end;
// unquoted fields are scanned once with charCodeAt and cut out with a single
// slice (an indexOf('\r') jump would scan unboundedly to the next CR, which
// in LF files is thousands of characters away). A record whose line holds no
// quote and no stray CR is split in one go with split(',').
// Anything broken (quotes, stray CRs, doubled quotes, junk after a closing
// quote, unterminated quotes) falls back to a field-by-field reader that
// follows the reference policy exactly:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled
//     ("" inside it is one quote; each CRLF or lone CR inside it reads as LF);
//     what follows its closing quote up to the next comma or line break is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's
//     width; each error is {code, line, row} in the order met, line the
//     1-based line its record starts on (every LF, CRLF and lone CR inside a
//     quoted field counted), row its record's index in rows, null for the
//     header.
//
// Field readers report through shared slots (fv: the field's value, fe: how
// it ended, fa: characters appended after the starting value) instead of
// allocating a result object per field, to keep the collector quiet.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next.

// How a field ended: at a comma, at a line break, or at the end of the text.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Field readers report errors against these.
  let recLine = 1;
  let recRow = null;

  // The field just read: its value, how it ended, and how many characters
  // were appended after its starting value.
  let fv = '';
  let fe = END;
  let fa = 0;

  function pushErr(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // Count LF characters in s (used for line breaks inside quoted fields).
  function countLF(s) {
    let n = 0;
    let i = -1;
    while ((i = s.indexOf('\n', i + 1)) !== -1) n += 1;
    return n;
  }

  // Reads an unquoted field starting at pos, with `init` as its starting
  // value, into fv/fe/fa. `fa` counts the characters kept after init
  // (stray CRs dropped on the way do not count). One scan with charCodeAt:
  // the native indexOf jumps look cheap per call, but indexOf('\r') scans
  // unboundedly to the next CR, which in LF files is thousands of
  // characters away, so a single pass over the field's own characters wins.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    let start = pos;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) { // ,
        if (pos > start) {
          const seg = text.slice(start, pos);
          value += seg;
          added += seg.length;
        }
        pos += 1;
        fv = value; fe = COMMA; fa = added;
        return;
      }
      if (c === 10) { // \n
        if (pos > start) {
          const seg = text.slice(start, pos);
          value += seg;
          added += seg.length;
        }
        pos += 1;
        line += 1;
        fv = value; fe = LINE_BREAK; fa = added;
        return;
      }
      if (c === 13) { // \r
        if (pos > start) {
          const seg = text.slice(start, pos);
          value += seg;
          added += seg.length;
        }
        // CRLF ends the record, a lone CR is dropped (stray_cr).
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fv = value; fe = LINE_BREAK; fa = added;
          return;
        }
        pushErr('stray_cr');
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    if (pos > start) {
      const seg = text.slice(start, pos);
      value += seg;
      added += seg.length;
    }
    fv = value; fe = END; fa = added;
  }

  // Reads a quoted field whose opening quote is at pos, into fv/fe/fa.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let segStart = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushErr('unterminated_quote');
        readUnquoted('"');
        return;
      }
      // The run [segStart, q): CRLF and lone CRs inside quotes each read
      // as one LF, and each counts as a line break.
      if (q > segStart) {
        const seg = text.slice(segStart, q);
        if (seg.indexOf('\r') === -1) {
          value += seg;
          if (seg.indexOf('\n') !== -1) line += countLF(seg);
        } else {
          const norm = seg.replace(/\r\n?/g, '\n');
          value += norm;
          line += countLF(norm);
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote inside the field.
        value += '"';
        pos = q + 2;
        segStart = pos;
        continue;
      }
      pos = q + 1;
      if (pos >= len) { fv = value; fe = END; fa = 0; return; }
      const c = text.charCodeAt(pos);
      if (c === 44) { // ,
        pos += 1;
        fv = value; fe = COMMA; fa = 0;
        return;
      }
      if (c === 10) { // \n
        pos += 1;
        line += 1;
        fv = value; fe = LINE_BREAK; fa = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) { // \r\n
        pos += 2;
        line += 1;
        fv = value; fe = LINE_BREAK; fa = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (fa > 0) pushErr('quote_junk');
      return;
    }
  }

  // Files one record's fields: the header, or a row padded/cut to width.
  function commit(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;

    // Fast path: this record's line holds no quote and no stray CR, so the
    // whole record is one split(','). A trailing CR right before the LF is
    // the CRLF ending; a CR anywhere else (or at EOF) means broken input
    // and falls through to the field reader.
    const lineEnd = text.indexOf('\n', pos);
    const end = lineEnd === -1 ? len : lineEnd;
    const hasNL = lineEnd !== -1;
    const qPos = text.indexOf('"', pos);
    if (qPos === -1 || qPos >= end) {
      const rPos = text.indexOf('\r', pos);
      if (rPos === -1 || rPos >= end || (hasNL && rPos === end - 1)) {
        const contentEnd = hasNL && rPos === end - 1 ? end - 1 : end;
        const fields = text.slice(pos, contentEnd).split(',');
        pos = hasNL ? end + 1 : len;
        if (hasNL) line += 1;
        // A line that held only stray CRs is left with no characters: no
        // record (kept for safety; the skip loop above already eats empty
        // lines, so this fires only on a lone empty field).
        if (fields.length === 1 && fields[0] === '') continue;
        commit(fields);
        continue;
      }
    }

    // General path: at least one field is quoted or a CR needs handling.
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted(); else readUnquoted('');
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    commit(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
