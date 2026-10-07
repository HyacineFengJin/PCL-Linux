import { randomUUID } from 'node:crypto';
import { parseJson, fail, freeze } from './json.mjs';

const MAX_NOTICES = 16;
const MAX_RUN_NOTICES = 64;
const unsafe = /[\p{Cc}\p{Cf}\p{Cs}]/u;
function text(value, limit) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value ||
      [...value].length > limit || unsafe.test(value))
    fail('NOTICE_TEXT', 'Notification text must be bounded and free of control characters.');
  return value;
}
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    fail('NOTICE_FIELDS', 'Invalid notification transport fields.');
}

/** Trusted RH owner of one executable-prototype lifetime, not an execution
 * engine. The owner supplies identity/consent; sidecar JSON supplies only text.
 * Stop/revoke is terminal. A new process needs a new owner/session ID. These
 * transient notices are never installed or restored from extension grants. */
export class RuntimeNoticeHost {
  #owner;
  #sessionId = randomUUID();
  #active = true;
  #lastSequence = 0;
  #notices = [];

  constructor({ extensionId, extensionName, granted = false }) {
    if (granted !== true) fail('NOTICE_PERMISSION', 'Notification capability needs an explicit host grant.');
    this.#owner = freeze({ extensionId: text(extensionId, 128), extensionName: text(extensionName, 80) });
  }

  get sessionId() { return this.#sessionId; }
  get active() { return this.#active; }

  acceptBatch(source) {
    if (!this.#active) fail('NOTICE_STOPPED', 'This notification lifetime has stopped.');
    const batch = parseJson(source);
    fields(batch, ['schemaVersion', 'sessionId', 'notices']);
    if (batch.schemaVersion !== 1 || batch.sessionId !== this.#sessionId)
      fail('NOTICE_SESSION', 'Notification batch belongs to a different run.');
    if (!Array.isArray(batch.notices) || batch.notices.length > MAX_NOTICES)
      fail('NOTICE_LIMIT', 'Notification batch exceeds the host limit.');
    // Validate the entire batch before advancing the replay boundary. A bad
    // last item may neither publish earlier items nor consume their sequence.
    let sequence = this.#lastSequence;
    const next = batch.notices.map(notice => {
      fields(notice, ['sequence', 'severity', 'message']);
      if (!Number.isSafeInteger(notice.sequence) || notice.sequence !== sequence + 1)
        fail('NOTICE_SEQUENCE', 'Notification sequence is stale, skipped or replayed.');
      if (notice.sequence > MAX_RUN_NOTICES) fail('NOTICE_LIMIT', 'This run exhausted its notification allowance.');
      sequence = notice.sequence;
      if (!['information', 'warning'].includes(notice.severity))
        fail('NOTICE_SEVERITY', 'Unsupported notification severity.');
      return { sequence, severity: notice.severity, message: text(notice.message, 1000) };
    });
    if (this.#notices.length + next.length > MAX_NOTICES)
      fail('NOTICE_LIMIT', 'Dismiss pending notifications before accepting more.');
    this.#lastSequence = sequence;
    this.#notices.push(...next);
  }

  cards({ informationTitle, warningTitle }) {
    // Titles are supplied by RH localization, never the plugin. The existing CE
    // card shape accepts plain text and has no executable callback or URL.
    const titles = { information: text(informationTitle, 100), warning: text(warningTitle, 100) };
    return freeze(this.#notices.map(notice => ({
      ...this.#owner, id: `${this.#sessionId}:${notice.sequence}`,
      title: titles[notice.severity], text: notice.message, actions: [],
    })));
  }

  dismiss(cardId) {
    const index = this.#notices.findIndex(notice => `${this.#sessionId}:${notice.sequence}` === cardId);
    if (index < 0) return false;
    this.#notices.splice(index, 1);
    return true;
  }

  stop() {
    this.#active = false;
    this.#notices = [];
    // Keep the high-water mark and terminal state: stop/start cannot make an
    // already-delivered callback valid again. Restarts construct a new owner.
  }
}
