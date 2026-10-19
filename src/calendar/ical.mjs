import { randomUUID } from 'node:crypto';

/**
 * Format a UTC datetime for iCal DTSTAMP/DTSTART/DTEND.
 * @param {string} iso
 */
function toIcalUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid datetime');
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build a full VCALENDAR document with one VEVENT.
 * @param {object} input
 * @returns {string}
 */
export function buildVeventIcal(input) {
  const uid = assertSingleLineValue(input.uid ?? randomUUID(), 'uid');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AgentCalendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcalUtc(new Date().toISOString())}`
  ];
  if (input.summary) lines.push(`SUMMARY:${escapeIcalText(input.summary)}`);
  if (input.description) lines.push(`DESCRIPTION:${escapeIcalText(input.description)}`);
  if (input.location) lines.push(`LOCATION:${escapeIcalText(input.location)}`);
  if (input.start) lines.push(`DTSTART:${toIcalUtc(input.start)}`);
  if (input.end) lines.push(`DTEND:${toIcalUtc(input.end)}`);
  if (input.organizer) lines.push(`ORGANIZER:mailto:${assertSingleLineValue(input.organizer, 'organizer')}`);
  for (const attendee of input.attendees ?? []) {
    lines.push(`ATTENDEE:mailto:${assertSingleLineValue(attendee, 'attendee')}`);
  }
  if (input.recurrenceRule) lines.push(`RRULE:${assertSingleLineValue(input.recurrenceRule, 'recurrenceRule')}`);
  if (input.reminderMinutesBefore != null) {
    const minutes = Number(input.reminderMinutesBefore);
    if (!Number.isInteger(minutes) || minutes <= 0) throw new TypeError('invalid reminder');
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcalText(input.summary ?? 'Calendar reminder')}`,
      `TRIGGER:-PT${minutes}M`,
      'END:VALARM'
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Escape special characters in iCal text values per RFC 5545 §3.3.11.
 * CR is folded away (treated as part of a line terminator) so an embedded \r cannot
 * survive into the serialized property value, matching the existing \n handling.
 * @param {string} value
 */
function escapeIcalText(value) {
  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Reject a value destined for a single-line iCal property (UID, ORGANIZER mailto,
 * ATTENDEE mailto, RRULE) if it contains any CR or LF. These properties are
 * interpolated verbatim rather than escaped, so an embedded line terminator would
 * let the caller inject arbitrary extra VEVENT/VALARM/VCALENDAR properties or
 * attendees — this must fail closed rather than silently strip or fold.
 * @param {string} value Candidate single-line value.
 * @param {string} field Field name, used only in the thrown error for diagnostics.
 * @returns {string} The same value, when it is safe to interpolate.
 * @throws {TypeError} When value contains a carriage return or line feed.
 */
function assertSingleLineValue(value, field) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new TypeError(`invalid ${field}: must not contain CR or LF`);
  return text;
}

/**
 * Parse minimal fields from a VEVENT-containing iCal document.
 * @param {string} icalBody
 */
export function parseVeventFields(icalBody) {
  const unfolded = icalBody.replace(/\r\n[ \t]/g, '');
  const fields = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (key === 'UID') fields.uid = value;
    if (key === 'SUMMARY') fields.summary = unescapeIcalText(value);
    if (key === 'DESCRIPTION') fields.description = unescapeIcalText(value);
    if (key === 'LOCATION') fields.location = unescapeIcalText(value);
    if (key === 'DTSTART') fields.start = value;
    if (key === 'DTEND') fields.end = value;
  }
  return fields;
}

/**
 * @param {string} value
 */
function unescapeIcalText(value) {
  return value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
