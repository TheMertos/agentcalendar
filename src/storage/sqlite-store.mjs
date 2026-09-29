import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS active_accounts (
    account_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    provider TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    connection_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendars (
    account_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    display_name TEXT,
    color TEXT,
    timezone TEXT,
    ctag TEXT,
    etag TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, calendar_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    account_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    uid TEXT NOT NULL,
    etag TEXT,
    summary TEXT,
    description TEXT,
    location TEXT,
    start_time TEXT,
    end_time TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    recurrence_rule TEXT,
    recurrence_id TEXT,
    attendees_json TEXT NOT NULL DEFAULT '[]',
    organizer TEXT,
    status TEXT,
    raw TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, calendar_id, uid)
  );
  CREATE INDEX IF NOT EXISTS events_account_time ON events(account_id, start_time);
  CREATE TABLE IF NOT EXISTS sync_checkpoints (
    account_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    calendar_ctag TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, calendar_id)
  );
`;

/**
 * SQLite persistence for accounts, calendar mirror, and sync checkpoints.
 * @param {string} [filename]
 */
export class SqliteCalendarStore {
  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.accountStatement = this.db.prepare(
      `INSERT INTO active_accounts(account_id, email, provider, secret_ref, connection_json, enabled, updated_at)
       VALUES (@id, @email, @provider, @secretRef, @connection, 1, @updatedAt)
       ON CONFLICT(account_id) DO UPDATE SET
         email=excluded.email, provider=excluded.provider, secret_ref=excluded.secret_ref,
         connection_json=excluded.connection_json, enabled=1, updated_at=excluded.updated_at`
    );
    this.accountDisableStatement = this.db.prepare(
      'UPDATE active_accounts SET enabled = 0, updated_at = @updatedAt WHERE account_id = @id'
    );
    this.upsertCalendarStatement = this.db.prepare(
      `INSERT INTO calendars(account_id, calendar_id, display_name, color, timezone, ctag, etag, updated_at)
       VALUES (@accountId, @calendarId, @displayName, @color, @timezone, @ctag, @etag, @updatedAt)
       ON CONFLICT(account_id, calendar_id) DO UPDATE SET
         display_name=excluded.display_name, color=excluded.color, timezone=excluded.timezone,
         ctag=excluded.ctag, etag=excluded.etag, updated_at=excluded.updated_at`
    );
    this.upsertEventStatement = this.db.prepare(
      `INSERT INTO events(account_id, calendar_id, uid, etag, summary, description, location, start_time, end_time,
         all_day, recurrence_rule, recurrence_id, attendees_json, organizer, status, raw, updated_at)
       VALUES (@accountId, @calendarId, @uid, @etag, @summary, @description, @location, @start, @end,
         @allDay, @recurrenceRule, @recurrenceId, @attendees, @organizer, @status, @raw, @updatedAt)
       ON CONFLICT(account_id, calendar_id, uid) DO UPDATE SET
         etag=excluded.etag, summary=excluded.summary, description=excluded.description, location=excluded.location,
         start_time=excluded.start_time, end_time=excluded.end_time, all_day=excluded.all_day,
         recurrence_rule=excluded.recurrence_rule, recurrence_id=excluded.recurrence_id,
         attendees_json=excluded.attendees_json, organizer=excluded.organizer, status=excluded.status,
         raw=excluded.raw, updated_at=excluded.updated_at`
    );
    this.checkpointStatement = this.db.prepare(
      `INSERT INTO sync_checkpoints(account_id, calendar_id, mode, event_count, calendar_ctag, updated_at)
       VALUES (@accountId, @calendarId, @mode, @eventCount, @calendarCtag, @updatedAt)
       ON CONFLICT(account_id, calendar_id) DO UPDATE SET
         mode=excluded.mode, event_count=excluded.event_count, calendar_ctag=excluded.calendar_ctag,
         updated_at=excluded.updated_at`
    );
  }

  activateAccount(account) {
    if (!account?.id || !account.email || !account.provider || !account.secretRef) {
      throw new TypeError('id, email, provider and secretRef are required');
    }
    this.accountStatement.run({
      id: account.id,
      email: account.email,
      provider: account.provider,
      secretRef: account.secretRef,
      connection: JSON.stringify(account.connection ?? {}),
      updatedAt: new Date().toISOString()
    });
    return this.getAccount(account.id);
  }

  deactivateAccount(id) {
    this.accountDisableStatement.run({ id, updatedAt: new Date().toISOString() });
  }

  getAccount(id) {
    const row = this.db.prepare('SELECT * FROM active_accounts WHERE account_id = ?').get(id);
    if (!row) return null;
    return {
      id: row.account_id,
      email: row.email,
      provider: row.provider,
      secretRef: row.secret_ref,
      connection: JSON.parse(row.connection_json),
      enabled: Boolean(row.enabled)
    };
  }

  listActiveAccounts() {
    return this.db
      .prepare('SELECT * FROM active_accounts WHERE enabled = 1 ORDER BY account_id')
      .all()
      .map((row) => ({
        id: row.account_id,
        email: row.email,
        provider: row.provider,
        secretRef: row.secret_ref,
        connection: JSON.parse(row.connection_json),
        enabled: true
      }));
  }

  upsertCalendar(calendar) {
    const updatedAt = new Date().toISOString();
    this.upsertCalendarStatement.run({
      accountId: calendar.accountId,
      calendarId: calendar.calendarId ?? calendar.id,
      displayName: calendar.displayName ?? null,
      color: calendar.color ?? null,
      timezone: calendar.timezone ?? null,
      ctag: calendar.ctag ?? null,
      etag: calendar.etag ?? null,
      updatedAt
    });
  }

  listCalendars(accountId) {
    return this.db
      .prepare('SELECT * FROM calendars WHERE account_id = ? ORDER BY calendar_id')
      .all(accountId)
      .map((row) => ({
        accountId: row.account_id,
        calendarId: row.calendar_id,
        displayName: row.display_name,
        color: row.color,
        timezone: row.timezone,
        ctag: row.ctag,
        etag: row.etag
      }));
  }

  getCheckpoint(accountId, calendarId) {
    const row = this.db
      .prepare('SELECT * FROM sync_checkpoints WHERE account_id = ? AND calendar_id = ?')
      .get(accountId, calendarId);
    if (!row) return null;
    return {
      accountId: row.account_id,
      calendarId: row.calendar_id,
      mode: row.mode,
      eventCount: row.event_count,
      calendarCtag: row.calendar_ctag,
      updatedAt: row.updated_at
    };
  }

  checkpoint({ accountId, calendarId, mode, eventCount, calendarCtag }) {
    this.checkpointStatement.run({
      accountId,
      calendarId,
      mode,
      eventCount,
      calendarCtag: calendarCtag ?? null,
      updatedAt: new Date().toISOString()
    });
  }

  upsertEvent(event) {
    this.upsertEventStatement.run({
      accountId: event.accountId,
      calendarId: event.calendarId,
      uid: event.uid,
      etag: event.etag ?? null,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      start: event.start ?? null,
      end: event.end ?? null,
      allDay: event.allDay ? 1 : 0,
      recurrenceRule: event.recurrenceRule ?? null,
      recurrenceId: event.recurrenceId ?? null,
      attendees: JSON.stringify(event.attendees ?? []),
      organizer: event.organizer ?? null,
      status: event.status ?? null,
      raw: event.raw ?? null,
      updatedAt: new Date().toISOString()
    });
  }

  getEvent(accountId, calendarId, uid) {
    const row = this.db
      .prepare('SELECT * FROM events WHERE account_id = ? AND calendar_id = ? AND uid = ?')
      .get(accountId, calendarId, uid);
    return row ? this.#rowToEvent(row) : null;
  }

  getEventByKey(eventKey) {
    const parts = eventKey.split('::');
    if (parts.length !== 3) return null;
    return this.getEvent(parts[0], parts[1], parts[2]);
  }

  eventKey(accountId, calendarId, uid) {
    return `${accountId}::${calendarId}::${uid}`;
  }

  searchEvents(accountId, { query = '', start = null, end = null, limit = 50 } = {}) {
    const clauses = ['account_id = @accountId'];
    const params = { accountId, limit };
    if (query) {
      clauses.push('(summary LIKE @q OR description LIKE @q OR location LIKE @q)');
      params.q = `%${query}%`;
    }
    if (start) {
      clauses.push('(end_time IS NULL OR end_time >= @start)');
      params.start = start;
    }
    if (end) {
      clauses.push('(start_time IS NULL OR start_time <= @end)');
      params.end = end;
    }
    const sql = `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY start_time LIMIT @limit`;
    return this.db.prepare(sql).all(params).map((row) => this.#rowToEvent(row));
  }

  #rowToEvent(row) {
    return {
      accountId: row.account_id,
      calendarId: row.calendar_id,
      uid: row.uid,
      etag: row.etag,
      summary: row.summary,
      description: row.description,
      location: row.location,
      start: row.start_time,
      end: row.end_time,
      allDay: Boolean(row.all_day),
      recurrenceRule: row.recurrence_rule,
      recurrenceId: row.recurrence_id,
      attendees: JSON.parse(row.attendees_json),
      organizer: row.organizer,
      status: row.status,
      raw: row.raw,
      updatedAt: row.updated_at,
      eventKey: this.eventKey(row.account_id, row.calendar_id, row.uid)
    };
  }

  close() {
    this.db.close();
  }
}
