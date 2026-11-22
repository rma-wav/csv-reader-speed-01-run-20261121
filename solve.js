// A faster drop-in for csv-reader 1.0.0: identical answers, less CPU.
//
// Semantics (from the competition rules, verified against the reference):
// - A U+FEFF at the very start is dropped. A record ends at LF or CRLF; a
//   line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled
//   ("" inside is one quote; CRLF or a lone CR inside reads as LF). What
//   follows the closing quote up to the next comma or line break is appended
//   as it stands (quote_junk when the field ends, if anything was appended).
//   A quote that never closes is a literal character, and that field alone
//   is read again as unquoted (unterminated_quote, reported at once, before
//   any error the re-read finds); the next field parses normally.
// - A quote inside an unquoted field is literal. Fields stay strings.
// - columns is the first record when header is true, else null; rows hold
//   the rest, each padded (short_row, with fields: its field count) or cut
//   (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; line is the 1-based
//   line its record starts on (blank lines and line breaks inside quotes
//   count; a stray CR outside quotes does not), row its index in rows,
//   null for the header.
//
// Speed shape: one indexOf chain finds every lone CR up front, so no scan
// ever hunts for a rare character unboundedly. Unquoted fields end at the
// nearer of the next comma and the next newline (the newline is tracked
// once per record). Quoted fields are found with indexOf('"') and sliced
// whole when they hold no doubled quote and no line break.

export function run(input) {
  const text = input.text;
  const header = input.header;
  const n = text.length;

  // Lone CRs (a CR not followed by LF), in order. One chained indexOf pass:
  // each call lands on the next CR, so the whole pass is linear.
  const lone = [];
  let p = text.indexOf('\r');
  while (p !== -1) {
    if (text.charCodeAt(p + 1) !== 10) lone.push(p);
    p = text.indexOf('\r', p + 1);
  }
  const L = lone.length;
  let li = 0; // first lone CR at or after the position being scanned

  let pos = 0;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;
  let line = 1;
  let columns = header ? [] : null;
  const rows = [];
  const errors = [];
  let width = -1;
  let nl = -1; // first LF at or after the current scan position, -1 unknown
  // A stray CR dropped at a record start begins the next field as unquoted:
  // a quote right after it is literal, not an opening quote. (A blank line
  // after it is still no record.)
  let noQuoteFirst = false;

  while (pos < n) {
    // At a record start: blank lines are no record, a lone CR here is a
    // stray CR of the record that follows.
    for (;;) {
      if (pos >= n) break;
      const c0 = text.charCodeAt(pos);
      if (c0 === 10) {
        pos++;
        line++;
        noQuoteFirst = false;
      } else if (c0 === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
        noQuoteFirst = false;
      } else if (c0 === 13) {
        errors.push({
          code: 'stray_cr',
          line,
          row: width === -1 && header ? null : rows.length,
        });
        pos++;
        noQuoteFirst = true;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recLine = line;
    const isFirst = width === -1;
    const rowIdx = isFirst && header ? null : rows.length;
    const fields = [];
    let recordDone = false;

    while (!recordDone) {
      if (pos >= n) {
        // A trailing comma at EOF leaves one last empty field.
        fields.push('');
        recordDone = true;
        break;
      }
      let value = '';
      let ended = false;
      // The first field of a record that began with a dropped stray CR is
      // already unquoted: a quote there is literal.
      const forceUnquoted = fields.length === 0 && noQuoteFirst;
      noQuoteFirst = false;

      if (text.charCodeAt(pos) === 34 && !forceUnquoted) {
        // Quoted field: find its closing quote, skipping doubled ones.
        const quotePos = pos;
        const quoteLine = line;
        let q = pos + 1;
        let hasDoubled = false;
        let close = -1;
        for (;;) {
          const nx = text.indexOf('"', q);
          if (nx === -1) break;
          if (text.charCodeAt(nx + 1) === 34) {
            hasDoubled = true;
            q = nx + 2;
          } else {
            close = nx;
            break;
          }
        }

        if (close === -1) {
          // Never closes: literal quote, and only this field reads again
          // as unquoted; the next field parses normally.
          errors.push({ code: 'unterminated_quote', line: recLine, row: rowIdx });
          pos = quotePos + 1;
          line = quoteLine;
          value = '"';
          // Fall through to the unquoted scan below, from the rewound pos.
        } else {
          // The quoted content, [pos + 1, close).
          let breaks = 0;
          const lfAt = text.indexOf('\n', pos + 1);
          const hasLF = lfAt !== -1 && lfAt < close;
          const crAt = text.indexOf('\r', pos + 1);
          const hasCR = crAt !== -1 && crAt < close;
          while (li < L && lone[li] < pos + 1) li++;
          const hasLone = li < L && lone[li] < close;
          if (!hasDoubled && !hasLone && !hasCR) {
            // Nothing to transform: slice whole, just count line breaks.
            value = text.slice(pos + 1, close);
            if (hasLF) {
              let lp = text.indexOf('\n', pos + 1);
              while (lp !== -1 && lp < close) {
                breaks++;
                lp = text.indexOf('\n', lp + 1);
              }
            }
          } else {
            // Build it: "" -> ", CRLF or lone CR -> LF, LF stays; count breaks.
            let out = '';
            let s0 = pos + 1;
            let i = s0;
            while (i < close) {
              const cc = text.charCodeAt(i);
              if (cc === 34) {
                if (text.charCodeAt(i + 1) === 34) {
                  out += text.slice(s0, i);
                  out += '"';
                  i += 2;
                  s0 = i;
                } else {
                  i++;
                }
              } else if (cc === 13) {
                out += text.slice(s0, i);
                out += '\n';
                breaks++;
                i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
                s0 = i;
              } else {
                if (cc === 10) breaks++;
                i++;
              }
            }
            out += text.slice(s0, close);
            value = out;
          }
          line += breaks;

          // Junk after the closing quote, up to the next comma or line break.
          let jpos = close + 1;
          if (nl < jpos) nl = text.indexOf('\n', jpos);
          const c = text.indexOf(',', jpos);
          let e;
          if (c !== -1 && (nl === -1 || c < nl)) {
            e = c;
            ended = false;
          } else if (nl !== -1) {
            e = nl;
            ended = true;
          } else {
            e = n;
            ended = true;
          }
          let vend = e;
          if (ended && e > jpos && text.charCodeAt(e - 1) === 13) vend = e - 1;
          while (li < L && lone[li] < jpos) li++;
          if (li < L && lone[li] < e) {
            let junk = '';
            let seg = jpos;
            while (li < L && lone[li] < e) {
              const rp = lone[li++];
              junk += text.slice(seg, rp);
              seg = rp + 1;
              errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
            }
            junk += text.slice(seg, vend);
            if (junk.length > 0) {
              value += junk;
              errors.push({ code: 'quote_junk', line: recLine, row: rowIdx });
            }
          } else if (vend > jpos) {
            value += text.slice(jpos, vend);
            errors.push({ code: 'quote_junk', line: recLine, row: rowIdx });
          }
          pos = e === n ? n : e + 1;
          if (ended) {
            line++;
            recordDone = true;
          }
          fields.push(value);
          continue;
        }
      }

      // Unquoted field (also the re-read after an unterminated quote, with
      // value already holding the literal opening quote).
      if (nl < pos) nl = text.indexOf('\n', pos);
      const c = text.indexOf(',', pos);
      let e;
      if (c !== -1 && (nl === -1 || c < nl)) {
        e = c;
        ended = false;
      } else if (nl !== -1) {
        e = nl;
        ended = true;
      } else {
        e = n;
        ended = true;
      }
      let vend = e;
      if (ended && e > pos && text.charCodeAt(e - 1) === 13) vend = e - 1;
      while (li < L && lone[li] < pos) li++;
      if (li < L && lone[li] < e) {
        let v = value;
        let seg = pos;
        while (li < L && lone[li] < e) {
          const rp = lone[li++];
          v += text.slice(seg, rp);
          seg = rp + 1;
          errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
        }
        v += text.slice(seg, vend);
        value = v;
      } else {
        value += text.slice(pos, vend);
      }
      pos = e === n ? n : e + 1;
      if (ended) {
        line++;
        recordDone = true;
      }
      fields.push(value);
    }

    if (isFirst) {
      width = fields.length;
      if (header) columns = fields;
      else rows.push(fields);
    } else {
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recLine, row: rowIdx, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recLine, row: rowIdx, extra: fields.slice(width) });
        fields.length = width;
      }
      rows.push(fields);
    }
  }

  return { columns, rows, errors };
}
