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
  const uid = input.uid ?? randomUUID();
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
  if (input.organizer) lines.push(`ORGANIZER:mailto:${input.organizer}`);
  for (const attendee of input.attendees ?? []) {
    lines.push(`ATTENDEE:mailto:${attendee}`);
  }
  if (input.recurrenceRule) lines.push(`RRULE:${input.recurrenceRule}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Escape special characters in iCal text values.
 * @param {string} value
 */
function escapeIcalText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
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
