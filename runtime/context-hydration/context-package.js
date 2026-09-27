/**
 * Context Hydration v1 — ContextPackage + Omission Metadata
 *
 * Policy: context-hydration@1.0.1
 * Contract: governance/contracts/context-hydration-v1.md (§11, §12)
 *
 * Assembles the deterministic ContextPackage envelope from mandatory
 * context, ranked candidates, and the budget record; projects retrieved
 * knowledge records preserving the selected candidate payload; builds
 * omission metadata for candidates excluded by the retrieval budget; and
 * provides a minimal deterministic in-memory omission store that enforces
 * the 30-day retention boundary on every read.
 *
 * No DB infrastructure. No network. No environment access. No wall-clock
 * reads: every retention check takes an explicit retention_current_time.
 */

'use strict';

const {
  POLICY_ID,
  POLICY_VERSION,
  BudgetError,
  computeBudget,
  deduplicateCandidates,
  applyRetrievalBudget,
  isNonNegativeInteger,
} = require('./budget.js');

/** Policy 1.0.1 omission.retention_seconds (30 days). */
const RETENTION_SECONDS = 2592000;

/** Policy 1.0.1 context_package.required_fields. */
const CONTEXT_PACKAGE_REQUIRED_FIELDS = [
  'hydration_run_id',
  'policy_id',
  'policy_version',
  'hydration_started_at',
  'objective',
  'job_id',
  'session_id',
  'mandatory',
  'retrieved',
  'omitted',
  'budget',
];

/** Policy 1.0.1 context_package.retrieved_audit_fields. */
const RETRIEVED_AUDIT_FIELDS = [
  'source_id',
  'source_type',
  'scope',
  'score',
  'rank',
  'reason',
  'provenance',
];

/** Policy 1.0.1 context_package.budget_audit_fields. */
const BUDGET_AUDIT_FIELDS = [
  'tokenizer_id',
  'context_window_tokens',
  'response_headroom_tokens',
  'execution_reserve_tokens',
  'active_conversation_tokens',
  'mandatory_context_tokens',
  'available_context_tokens',
  'retrieval_budget_tokens',
  'retrieved_tokens_used',
];

/** Policy 1.0.1 omission.allowed_metadata — exact allowlist. */
const OMISSION_ALLOWED_METADATA = [
  'source_id',
  'source_type',
  'scope',
  'score',
  'rank',
  'omission_reason',
  'estimated_tokens',
  'hydration_run_id',
  'omitted_at',
  'expires_at',
];

const OMISSION_REASONS = {
  RETRIEVAL_BUDGET_EXCEEDED: 'retrieval_budget_exceeded',
};

const RETRIEVED_REASON = 'retrieved';

const PACKAGE_ERROR_CODES = {
  INVALID_CONTEXT_PACKAGE: 'INVALID_CONTEXT_PACKAGE',
  INVALID_HYDRATION_ANCHOR: 'INVALID_HYDRATION_ANCHOR',
  INVALID_RETENTION_TIME: 'INVALID_RETENTION_TIME',
  INVALID_OMISSION_METADATA: 'INVALID_OMISSION_METADATA',
};

/**
 * Exact forbidden field names (governance/schemas/execution-context.json).
 * Compared case-insensitively against object keys.
 */
const FORBIDDEN_FIELD_NAMES = [
  'password',
  'token',
  'secret',
  'apikey',
  'authorization',
  'credential',
  'raw_query',
  'connection_string',
];

class ContextPackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextPackageError';
    this.code = code;
  }
}

/**
 * Strict RFC3339 UTC timestamp pattern — canonical project form only:
 * `YYYY-MM-DDTHH:MM:SS[.fraction]Z` with uppercase T/Z and no offset.
 * Fractional seconds are `1*DIGIT` (arbitrary precision), matching the
 * Ranking lane parser, so the same hydration_started_at is accepted by both.
 */
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

/** Days since 1970-01-01 for a proleptic Gregorian civil date. */
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Civil date from days since 1970-01-01 (inverse of daysFromCivil). */
function civilFromDays(days) {
  const z = days + 719468n;
  const era = (z >= 0n ? z : z - 146096n) / 146097n;
  const doe = z - era * 146097n;
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const year = yoe + era * 400n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp + (mp < 10n ? 3n : -9n);
  return {
    year: year + (month <= 2n ? 1n : 0n),
    month,
    day,
  };
}

/**
 * Parse an RFC3339 UTC timestamp to an exact representation:
 *   { seconds: BigInt, fractionDigits: string }
 * where `seconds` is Unix epoch seconds and `fractionDigits` is the exact
 * fractional-second digit string as written (empty when absent).
 * Returns null when the value is not a valid RFC3339 UTC timestamp.
 *
 * Strict validation: the value must match the RFC3339 UTC syntax AND carry
 * real calendar/time components. `Date.parse` alone is insufficient because
 * it normalizes syntactically shaped but invalid dates (for example
 * `2026-02-30T00:00:00Z` becomes March 2), and it reduces fractional seconds
 * to milliseconds. Epoch seconds are therefore computed exactly from the
 * validated components, and the full fractional digit string is preserved
 * (RFC3339 fractional seconds are `1*DIGIT`).
 *
 * Leap seconds (second = 60) are not representable and are deterministically
 * rejected.
 *
 * Deterministic: relies only on the string value, never on wall clock.
 */
function parseRfc3339Utc(value) {
  if (typeof value !== 'string') return null;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const days = daysFromCivil(year, month, day);
  const seconds = BigInt(days) * 86400n + BigInt(hour * 3600 + minute * 60 + second);
  return { seconds, fractionDigits: match[7] || '' };
}

/**
 * Compare two parsed timestamps chronologically with full fractional
 * precision: -1 | 0 | 1. Instants written at different precisions but with
 * equal value (`.1Z` vs `.100000Z`) compare equal.
 */
function compareRfc3339Parsed(a, b) {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  const length = Math.max(a.fractionDigits.length, b.fractionDigits.length);
  const aFraction = a.fractionDigits.padEnd(length, '0');
  const bFraction = b.fractionDigits.padEnd(length, '0');
  if (aFraction === bFraction) return 0;
  return aFraction < bFraction ? -1 : 1;
}

/**
 * Render a parsed timestamp back to canonical RFC3339 UTC. Explicit fractional
 * digits are preserved verbatim (any precision); timestamps without a
 * fractional component render with the canonical millisecond form `.000`
 * (preserving prior behavior).
 */
function formatRfc3339Utc(parsed) {
  const days = parsed.seconds >= 0n
    ? parsed.seconds / 86400n
    : (parsed.seconds - 86399n) / 86400n;
  const secondsOfDay = parsed.seconds - days * 86400n;
  const civil = civilFromDays(days);
  const hour = secondsOfDay / 3600n;
  const minute = (secondsOfDay % 3600n) / 60n;
  const second = secondsOfDay % 60n;
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad4 = (n) => String(n).padStart(4, '0');
  const fractionDigits = parsed.fractionDigits.length === 0 ? '000' : parsed.fractionDigits;
  return (
    `${pad4(civil.year)}-${pad2(civil.month)}-${pad2(civil.day)}` +
    `T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${fractionDigits}Z`
  );
}

/**
 * expires_at = omitted_at + seconds (exact arithmetic on epoch seconds).
 * The exact fractional component of the anchor is preserved at full
 * precision; anchors without a fractional component render with the
 * canonical `.000` millisecond form.
 * Returns null when the anchor is not a valid RFC3339 UTC timestamp.
 */
function addSeconds(rfc3339Utc, seconds) {
  const parsed = parseRfc3339Utc(rfc3339Utc);
  if (parsed === null) return null;
  return formatRfc3339Utc({
    seconds: parsed.seconds + BigInt(seconds),
    fractionDigits: parsed.fractionDigits,
  });
}

/**
 * Policy 1.0.1 expiry boundary: retention_current_time >= expires_at means
 * the record is EXPIRED. Both times are RFC3339 UTC strings compared with
 * full fractional precision (never reduced to milliseconds).
 */
function isExpired(record, retentionCurrentTime) {
  if (record === null || typeof record !== 'object') {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'omission metadata must be a plain object'
    );
  }
  const current = parseRfc3339Utc(retentionCurrentTime);
  if (current === null) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_RETENTION_TIME,
      'retention_current_time must be an RFC3339 UTC timestamp'
    );
  }
  const expires = parseRfc3339Utc(record.expires_at);
  if (expires === null) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'record.expires_at must be an RFC3339 UTC timestamp'
    );
  }
  return compareRfc3339Parsed(current, expires) >= 0;
}

/**
 * Build the omission metadata record for one excluded candidate.
 *
 * Persists ONLY the policy-allowed metadata fields; full omitted content can
 * never enter the record because the record is constructed field by field.
 *
 * omitted_at = hydration_started_at (policy omitted_at_source)
 * expires_at = omitted_at + 2592000 seconds (30 days)
 */
function createOmissionMetadata(candidate, context) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'candidate must be a plain object'
    );
  }
  if (typeof candidate.source_id !== 'string' || candidate.source_id.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'candidate must carry a non-empty source_id'
    );
  }
  if (typeof candidate.source_type !== 'string' || candidate.source_type.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'candidate must carry a non-empty source_type'
    );
  }
  if (!isNonNegativeInteger(candidate.estimated_tokens)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'candidate.estimated_tokens must be a non-negative integer'
    );
  }
  if (context === null || typeof context !== 'object') {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'omission context must be a plain object'
    );
  }
  if (typeof context.hydration_run_id !== 'string' || context.hydration_run_id.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'hydration_run_id must be a non-empty string'
    );
  }
  if (parseRfc3339Utc(context.hydration_started_at) === null) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_HYDRATION_ANCHOR,
      'hydration_started_at must be an RFC3339 UTC timestamp'
    );
  }
  if (typeof context.omission_reason !== 'string' || context.omission_reason.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'omission_reason must be a non-empty string'
    );
  }

  const omittedAt = context.hydration_started_at;
  const expiresAt = addSeconds(omittedAt, RETENTION_SECONDS);
  const rank = context.rank !== undefined
    ? context.rank
    : (candidate.rank !== undefined ? candidate.rank : null);

  return {
    source_id: candidate.source_id,
    source_type: candidate.source_type,
    scope: candidate.scope !== undefined ? candidate.scope : null,
    score: candidate.score !== undefined ? candidate.score : null,
    rank,
    omission_reason: context.omission_reason,
    estimated_tokens: candidate.estimated_tokens,
    hydration_run_id: context.hydration_run_id,
    omitted_at: omittedAt,
    expires_at: expiresAt,
  };
}

const OMISSION_METADATA_REQUIRED_FIELDS = [
  'source_id',
  'source_type',
  'omission_reason',
  'estimated_tokens',
  'hydration_run_id',
  'omitted_at',
  'expires_at',
];

/**
 * Validate that a record is allowed omission metadata:
 *  - every key is on the policy allowlist (full content can never be stored)
 *  - required fields are present and well-typed
 *  - expires_at exactly equals omitted_at + 2592000 seconds
 *
 * Fails closed with INVALID_OMISSION_METADATA.
 */
function assertAllowedOmissionMetadata(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'omission metadata must be a plain object'
    );
  }
  for (const key of Object.keys(record)) {
    if (!OMISSION_ALLOWED_METADATA.includes(key)) {
      throw new ContextPackageError(
        PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
        `disallowed omission metadata field: ${key}`
      );
    }
  }
  for (const field of OMISSION_METADATA_REQUIRED_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      throw new ContextPackageError(
        PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
        `missing required omission metadata field: ${field}`
      );
    }
  }
  if (typeof record.source_id !== 'string' || record.source_id.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'source_id must be a non-empty string'
    );
  }
  if (typeof record.source_type !== 'string' || record.source_type.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'source_type must be a non-empty string'
    );
  }
  if (typeof record.omission_reason !== 'string' || record.omission_reason.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'omission_reason must be a non-empty string'
    );
  }
  if (typeof record.hydration_run_id !== 'string' || record.hydration_run_id.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'hydration_run_id must be a non-empty string'
    );
  }
  if (!isNonNegativeInteger(record.estimated_tokens)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'estimated_tokens must be a non-negative integer'
    );
  }
  const omitted = parseRfc3339Utc(record.omitted_at);
  const expires = parseRfc3339Utc(record.expires_at);
  if (omitted === null || expires === null) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'omitted_at and expires_at must be RFC3339 UTC timestamps'
    );
  }
  const expectedExpires = {
    seconds: omitted.seconds + BigInt(RETENTION_SECONDS),
    fractionDigits: omitted.fractionDigits,
  };
  if (compareRfc3339Parsed(expires, expectedExpires) !== 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'expires_at must equal omitted_at + 2592000 seconds'
    );
  }
}

/**
 * Minimal deterministic in-memory omission metadata store (no DB).
 *
 * Retention enforcement (policy 1.0.1 omission contract):
 *  - every read/list/purge takes an explicit retention_current_time
 *  - records with retention_current_time >= expires_at are removed BEFORE
 *    the read completes (cleanup_before_post_expiry_read)
 *  - store initialization purges expired records before serving metadata
 *    (cleanup_on_store_initialization)
 *  - expired metadata is never returned and never used
 *
 * Only allowlisted omission metadata can be added; full omitted content can
 * never be persisted.
 */
function createOmissionStore(options = {}) {
  const initialRecords = options.records === undefined ? [] : options.records;
  const initializationTime = options.initialization_time === undefined
    ? null
    : options.initialization_time;
  if (!Array.isArray(initialRecords)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_OMISSION_METADATA,
      'records must be an array'
    );
  }

  const active = [];

  function purgeExpired(retentionCurrentTime) {
    if (parseRfc3339Utc(retentionCurrentTime) === null) {
      throw new ContextPackageError(
        PACKAGE_ERROR_CODES.INVALID_RETENTION_TIME,
        'retention_current_time must be an RFC3339 UTC timestamp'
      );
    }
    let removed = 0;
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (isExpired(active[i], retentionCurrentTime)) {
        active.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  const store = {
    add(record) {
      assertAllowedOmissionMetadata(record);
      active.push({ ...record });
      return { ...record };
    },
    purgeExpired,
    list(retentionCurrentTime) {
      purgeExpired(retentionCurrentTime);
      return active.map((record) => ({ ...record }));
    },
    get(hydrationRunId, retentionCurrentTime) {
      purgeExpired(retentionCurrentTime);
      return active
        .filter((record) => record.hydration_run_id === hydrationRunId)
        .map((record) => ({ ...record }));
    },
    size(retentionCurrentTime) {
      purgeExpired(retentionCurrentTime);
      return active.length;
    },
  };

  // Initialization must remove/inactivate expired metadata before serving.
  for (const record of initialRecords) {
    store.add(record);
  }
  if (initializationTime !== null) {
    store.purgeExpired(initializationTime);
  }

  return store;
}

/**
 * Recursively collect forbidden (secret-like) field names in a value.
 */
function findForbiddenKeys(value, pathPrefix = '') {
  const found = [];
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...findForbiddenKeys(item, `${pathPrefix}[${index}].`));
    });
    return found;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELD_NAMES.includes(key.toLowerCase())) {
      found.push(`${pathPrefix}${key}`);
    }
    found.push(...findForbiddenKeys(value[key], `${pathPrefix}${key}.`));
  }
  return found;
}

/**
 * Validate a ContextPackage against the policy-required field sets:
 * required envelope fields, retrieved audit fields, budget audit fields,
 * allowed omission metadata, and the no-secrets constraint.
 *
 * Fails closed with INVALID_CONTEXT_PACKAGE.
 */
function validateContextPackage(contextPackage) {
  if (contextPackage === null || typeof contextPackage !== 'object' || Array.isArray(contextPackage)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'ContextPackage must be a plain object'
    );
  }
  for (const field of CONTEXT_PACKAGE_REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(contextPackage, field)) {
      throw new ContextPackageError(
        PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
        `ContextPackage missing required field: ${field}`
      );
    }
  }
  if (
    !Array.isArray(contextPackage.mandatory) ||
    !Array.isArray(contextPackage.retrieved) ||
    !Array.isArray(contextPackage.omitted)
  ) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'mandatory, retrieved, and omitted must be arrays'
    );
  }
  for (const record of contextPackage.retrieved) {
    if (record === null || typeof record !== 'object') {
      throw new ContextPackageError(
        PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
        'retrieved record must be a plain object'
      );
    }
    for (const field of RETRIEVED_AUDIT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) {
        throw new ContextPackageError(
          PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
          `retrieved record missing audit field: ${field}`
        );
      }
    }
  }
  for (const record of contextPackage.omitted) {
    assertAllowedOmissionMetadata(record);
  }
  const budgetAudit = contextPackage.budget;
  if (budgetAudit === null || typeof budgetAudit !== 'object' || Array.isArray(budgetAudit)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'budget audit must be a plain object'
    );
  }
  for (const field of BUDGET_AUDIT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(budgetAudit, field)) {
      throw new ContextPackageError(
        PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
        `budget audit missing field: ${field}`
      );
    }
  }
  const forbidden = findForbiddenKeys(contextPackage);
  if (forbidden.length > 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      `ContextPackage must not persist secret-like fields: ${forbidden.join(', ')}`
    );
  }
  return true;
}

/**
 * Recursively copy a payload value while excluding forbidden (secret-like)
 * field names at every level. Plain objects and arrays are copied; primitives
 * pass through unchanged; non-plain objects pass through unchanged and remain
 * subject to the final ContextPackage secret guard.
 */
function sanitizePayload(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item));
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const copy = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_FIELD_NAMES.includes(key.toLowerCase())) continue;
      copy[key] = sanitizePayload(value[key]);
    }
    return copy;
  }
  return value;
}

/**
 * Safe retrieved-record projection (contract §11.1).
 *
 * `retrieved[]` means retrieved knowledge records: the selected candidate's
 * knowledge payload and candidate fields (content, body, text, structured
 * payloads, token-accounting metadata) are preserved, while the required
 * audit fields — source_id, source_type, scope, score, rank, reason,
 * provenance — are added/normalized.
 *
 * Forbidden secret-like fields are never copied into the package (excluded
 * recursively by sanitizePayload). The ContextPackage secret guard still
 * validates the complete package afterwards as a final defense.
 *
 * Never mutates the candidate.
 */
function projectRetrievedRecord(candidate, rank) {
  const record = sanitizePayload(candidate);
  return {
    ...record,
    source_id: record.source_id,
    source_type: record.source_type,
    scope: record.scope !== undefined ? record.scope : null,
    score: record.score !== undefined ? record.score : null,
    rank,
    reason: RETRIEVED_REASON,
    provenance: record.provenance !== undefined ? record.provenance : null,
  };
}

/**
 * Build the deterministic ContextPackage envelope (contract §11).
 *
 * Steps:
 *  1. validate the run anchor and envelope inputs
 *  2. compute the budget (mandatory overflow fails closed)
 *  3. deduplicate candidates deterministically
 *  4. enforce the retrieval budget (deterministic greedy fill)
 *  5. project retrieved knowledge records and omission metadata
 *  6. validate the complete ContextPackage
 *  7. persist omission metadata only after validation succeeds
 *
 * Mandatory context is preserved verbatim: it is never deduplicated, never
 * omitted, never truncated, and never silently dropped. When mandatory
 * context exceeds its usable budget the call fails with
 * CONTEXT_BUDGET_EXCEEDED instead.
 */
function buildContextPackage(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'buildContextPackage params must be a plain object'
    );
  }
  const {
    hydration_run_id,
    hydration_started_at,
    objective,
    job_id = null,
    session_id = null,
    mandatory,
    candidates,
    budget_inputs,
    omission_store = null,
  } = params;

  if (typeof hydration_run_id !== 'string' || hydration_run_id.length === 0) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'hydration_run_id must be a non-empty string'
    );
  }
  if (parseRfc3339Utc(hydration_started_at) === null) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_HYDRATION_ANCHOR,
      'hydration_started_at must be an RFC3339 UTC timestamp'
    );
  }
  if (objective === undefined || objective === null) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'objective is required'
    );
  }
  if (!Array.isArray(mandatory)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'mandatory must be an array'
    );
  }
  for (const record of mandatory) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new ContextPackageError(
        PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
        'mandatory records must be plain objects'
      );
    }
  }
  if (!Array.isArray(candidates)) {
    throw new ContextPackageError(
      PACKAGE_ERROR_CODES.INVALID_CONTEXT_PACKAGE,
      'candidates must be an array'
    );
  }

  // Budget: mandatory overflow fails closed with CONTEXT_BUDGET_EXCEEDED.
  const budget = computeBudget(budget_inputs);

  // Deterministic deduplication (mandatory context is not subject to it).
  const deduplicated = deduplicateCandidates(candidates);

  // Deterministic effective rank: explicit rank when carried, otherwise the
  // 1-based position in the deduplicated ranked order.
  const rankByCandidate = new Map();
  deduplicated.forEach((candidate, index) => {
    const explicitRank = candidate.rank;
    rankByCandidate.set(
      candidate,
      isNonNegativeInteger(explicitRank) && explicitRank > 0 ? explicitRank : index + 1
    );
  });

  // Retrieval budget enforcement.
  const split = applyRetrievalBudget(deduplicated, budget.retrieval_budget_tokens);

  // Retrieved records: preserve the selected knowledge payload and candidate
  // fields (content, body, text, structured payloads, token-accounting
  // metadata) while adding/normalizing the required audit fields
  // (contract §11.1). Forbidden secret-like fields are never copied.
  const retrieved = split.retrieved.map((candidate) =>
    projectRetrievedRecord(candidate, rankByCandidate.get(candidate))
  );

  // Omission metadata: allowed metadata only, never full content.
  const omitted = split.omitted.map((candidate) =>
    createOmissionMetadata(candidate, {
      hydration_run_id,
      hydration_started_at,
      omission_reason: OMISSION_REASONS.RETRIEVAL_BUDGET_EXCEEDED,
      rank: rankByCandidate.get(candidate),
    })
  );

  const contextPackage = {
    hydration_run_id,
    policy_id: POLICY_ID,
    policy_version: POLICY_VERSION,
    hydration_started_at,
    objective,
    job_id,
    session_id,
    mandatory: mandatory.map((record) => ({ ...record })),
    retrieved,
    omitted,
    budget: {
      tokenizer_id: budget.tokenizer_id,
      context_window_tokens: budget.context_window_tokens,
      response_headroom_tokens: budget.response_headroom_tokens,
      execution_reserve_tokens: budget.execution_reserve_tokens,
      active_conversation_tokens: budget.active_conversation_tokens,
      mandatory_context_tokens: budget.mandatory_context_tokens,
      available_context_tokens: budget.available_context_tokens,
      retrieval_budget_tokens: budget.retrieval_budget_tokens,
      retrieved_tokens_used: split.retrieved_tokens_used,
    },
  };

  // Validation MUST complete before any store write: a failed hydration run
  // must leave the omission store unchanged (side-effect-free failure).
  validateContextPackage(contextPackage);

  // Persist omission metadata only after the complete ContextPackage has
  // been validated successfully.
  if (omission_store !== null) {
    for (const metadata of omitted) {
      omission_store.add(metadata);
    }
  }

  return contextPackage;
}

module.exports = {
  RETENTION_SECONDS,
  CONTEXT_PACKAGE_REQUIRED_FIELDS,
  RETRIEVED_AUDIT_FIELDS,
  BUDGET_AUDIT_FIELDS,
  OMISSION_ALLOWED_METADATA,
  OMISSION_REASONS,
  RETRIEVED_REASON,
  PACKAGE_ERROR_CODES,
  ContextPackageError,
  parseRfc3339Utc,
  addSeconds,
  isExpired,
  createOmissionMetadata,
  assertAllowedOmissionMetadata,
  createOmissionStore,
  projectRetrievedRecord,
  buildContextPackage,
  validateContextPackage,
};
