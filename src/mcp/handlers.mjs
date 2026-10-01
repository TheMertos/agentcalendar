import { assertSafeMetadata } from '../core/account-registry.mjs';
import { createApproval, verifyApproval } from '../core/approval.mjs';
import { buildVeventIcal } from '../calendar/ical.mjs';

/**
 * Build MCP tool handler functions (testable without stdio transport).
 * @param {{ store: object, calendarService: object|null, pendingApprovals: Map }} deps
 */
export function createMcpHandlers({ store, calendarService, pendingApprovals }) {
  const registry = {
    list: () =>
      store.listActiveAccounts().map(({ secretRef, ...account }) => ({
        ...account,
        hasCredentialReference: true
      })),
    status: (id) => {
      const account = store.getAccount(id);
      return account
        ? {
            id: account.id,
            email: account.email,
            provider: account.provider,
            enabled: account.enabled,
            hasCredentialReference: true
          }
        : null;
    },
    register: (account) => {
      assertSafeMetadata(account.connection ?? {}, 'connection');
      return store.activateAccount(account);
    }
  };

  return {
    async calendar_account_list() {
      return registry.list();
    },

    async calendar_account_status({ accountId }) {
      const status = registry.status(accountId);
      return status ?? { error: 'account_not_found' };
    },

    async calendar_account_register(account) {
      try {
        return registry.register(account);
      } catch (error) {
        return { error: error.message };
      }
    },

    async calendar_account_deactivate({ accountId }) {
      store.deactivateAccount(accountId);
      return { accountId, status: 'inactive', localDataRetained: true };
    },

    async calendar_list({ accountId }) {
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      if (!calendarService) return { error: 'calendar_service_unavailable' };
      try {
        return await calendarService.listCalendars(accountId);
      } catch (error) {
        return { error: error.message };
      }
    },

    async calendar_sync({ accountId }) {
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      return remoteOnlyCalendarStatus(accountId);
    },

    async calendar_sync_all() {
      const accountIds = registry.list().map((account) => account.id);
      return {
        accounts: accountIds.map((accountId) => remoteOnlyCalendarStatus(accountId)),
        mode: 'remote-only',
        syncEnabled: false,
        syncStarted: false
      };
    },

    async event_search(input) {
      const accountId = input?.accountId;
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      if (typeof calendarService?.searchEvents !== 'function') return { error: 'calendar_service_unavailable' };
      try {
        return await calendarService.searchEvents(accountId, input ?? {});
      } catch (error) {
        return { error: error.message || 'provider_unavailable' };
      }
    },

    async event_read({ eventKey }) {
      const accountId = String(eventKey ?? '').split('::')[0];
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      if (typeof calendarService?.readEvent !== 'function') return { error: 'calendar_service_unavailable' };
      try {
        const event = await calendarService.readEvent(eventKey);
        return event ?? { error: 'event_not_found' };
      } catch (error) {
        return { error: error.message || 'provider_unavailable' };
      }
    },

    async event_preview(input) {
      const accountId = input.accountId;
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      const icalBody = buildVeventIcal({
        uid: input.uid,
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        attendees: input.attendees,
        organizer: input.organizer,
        recurrenceRule: input.recurrenceRule
      });
      return { accountId, calendarId: input.calendarId, uid: input.uid ?? null, icalBody };
    },

    async event_approval_create(payload) {
      if (!registry.status(payload.accountId)?.enabled) return { error: 'account_not_active' };
      const approval = createApproval(payload, { ttlSeconds: 300 });
      pendingApprovals.set(approval.id, { approval, payload });
      return approval;
    },

    async event_write({ approvalId, ...payload }) {
      const entry = pendingApprovals.get(approvalId);
      if (!entry) return { error: 'approval_not_found' };
      const normalized = {
        accountId: payload.accountId,
        calendarId: payload.calendarId,
        uid: payload.uid ?? null,
        icalBody: payload.icalBody
      };
      if (!verifyApproval(entry.approval, normalized)) return { error: 'approval_invalid_or_expired' };
      pendingApprovals.delete(approvalId);
      if (!calendarService) return { error: 'calendar_service_unavailable' };
      try {
        return await calendarService.writeEvent(normalized.accountId, normalized);
      } catch (error) {
        return { error: error.message };
      }
    },

    async sync_policy_get({ accountId, calendarId }) {
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      return store.getSyncPolicy(accountId, calendarId);
    },

    async sync_policy_set({ accountId, calendarId, autoUpload }) {
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      return store.setSyncPolicy(accountId, calendarId, { autoUpload: Boolean(autoUpload) });
    },

    async event_update_local(input) {
      if (!registry.status(input.accountId)?.enabled) return { error: 'account_not_active' };
      return { error: 'remote_only_local_writes_disabled' };
    },

    async event_upload_status({ accountId }) {
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      return { error: 'remote_only_sync_disabled' };
    },

    async event_conflicts({ accountId }) {
      if (!registry.status(accountId)?.enabled) return { error: 'account_not_active' };
      return { error: 'remote_only_sync_disabled' };
    }
  };
}

/**
 * Status payload when background calendar sync is disabled.
 * @param {string} accountId Account id.
 * @returns {object} Remote-only status without checkpoints.
 */
function remoteOnlyCalendarStatus(accountId) {
  return {
    accountId,
    mode: 'remote-only',
    syncEnabled: false,
    state: 'remote_only',
    calendars: [],
    syncStarted: false
  };
}
