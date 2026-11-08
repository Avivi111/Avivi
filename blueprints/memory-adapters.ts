/**
 * Process-local reference adapters for the agent kernel.
 *
 * These stores live in one process and are the default behind `createAgentKernel`.
 * Production hosts replace them with durable implementations. The memory
 * idempotency store must not be used for real money movement across processes.
 */

import type { AuditEvent, AuditSnapshot, CompleteResult } from "./agent-kernel.ts";

const DEFAULT_AUDIT_LIMIT = 1000;
const MAX_AUDIT_LIMIT = 10_000;

export interface StopSwitch {
  isStopped(): boolean;
  stop(reason: string): void;
  resume(): void;
  currentReason(): string;
}

export interface AuditLog {
  append(event: AuditEvent): void;
  snapshot(): AuditSnapshot;
}

export interface IdempotencyRecord {
  fingerprint: string;
  result: CompleteResult;
}

export interface IdempotencyPut {
  record: IdempotencyRecord;
  inserted: boolean;
}

/**
 * Atomic insert for one idempotency key.
 * Production implementations must use a uniqueness constraint.
 * `inserted` is false when a record for the key already existed.
 */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined;
  putIfAbsent(key: string, record: IdempotencyRecord): IdempotencyPut;
}

export function createMemoryStopSwitch(): StopSwitch {
  let stopped = false;
  let reason = "emergency_stop";
  return {
    isStopped: () => stopped,
    currentReason: () => reason,
    stop(next: string) {
      stopped = true;
      reason = next;
    },
    resume() {
      stopped = false;
    },
  };
}

export function createMemoryAuditLog(limit = DEFAULT_AUDIT_LIMIT): AuditLog {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
    throw new Error("invalid_audit_limit");
  }
  const events: AuditEvent[] = [];
  let dropped = 0;
  return {
    append(event: AuditEvent) {
      events.push(Object.freeze({
        ...event,
        detail: Object.freeze({ ...event.detail }),
      }));
      while (events.length > limit) {
        events.shift();
        dropped += 1;
      }
    },
    snapshot(): AuditSnapshot {
      return Object.freeze({
        events: Object.freeze(events.slice()),
        dropped,
      });
    },
  };
}

export function createMemoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord>();
  return {
    get(key: string) {
      return records.get(key);
    },
    putIfAbsent(key: string, record: IdempotencyRecord): IdempotencyPut {
      const existing = records.get(key);
      if (existing) return { record: existing, inserted: false };
      const stored = Object.freeze({
        fingerprint: record.fingerprint,
        result: Object.freeze({ ...record.result }),
      });
      records.set(key, stored);
      return { record: stored, inserted: true };
    },
  };
}
