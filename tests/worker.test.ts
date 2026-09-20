/**
 * Worker scheduler tests: cron parsing/matching, missed-window catch-up, and the
 * parent-detection payload used by the enrichment fallback.
 */
import { describe, expect, it } from 'vitest';
import {
  cronMatches,
  describeCron,
  didMissSchedule,
  fieldMatches,
  isValidCronExpression,
  minuteKey,
  nextRunAfter,
  parseCron,
} from '@/worker/cron';

describe('parseCron', () => {
  it('accepts 5-field expressions', () => {
    expect(() => parseCron('0 3 * * *')).not.toThrow();
    expect(() => parseCron('*/15 * * * *')).not.toThrow();
    expect(() => parseCron('0 6 * * 1')).not.toThrow();
    expect(() => parseCron('0,30 9-17 1,15 1-6 *')).not.toThrow();
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();
    expect(() => parseCron('70 * * * *')).toThrow();
    expect(() => parseCron('* 25 * * *')).toThrow();
    expect(() => parseCron('* * 0 * *')).toThrow();
    expect(() => parseCron('* * * 13 *')).toThrow();
    expect(() => parseCron('* * * * 9')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
    expect(isValidCronExpression('nonsense')).toBe(false);
  });
});

describe('fieldMatches', () => {
  it('matches wildcards and exact values', () => {
    expect(fieldMatches('*', 17, 0, 59)).toBe(true);
    expect(fieldMatches('17', 17, 0, 59)).toBe(true);
    expect(fieldMatches('17', 18, 0, 59)).toBe(false);
  });

  it('matches ranges, lists and steps', () => {
    expect(fieldMatches('1-5', 3, 0, 59)).toBe(true);
    expect(fieldMatches('1-5', 6, 0, 59)).toBe(false);
    expect(fieldMatches('1,3,5', 3, 0, 59)).toBe(true);
    expect(fieldMatches('1,3,5', 4, 0, 59)).toBe(false);
    expect(fieldMatches('*/15', 0, 0, 59)).toBe(true);
    expect(fieldMatches('*/15', 30, 0, 59)).toBe(true);
    expect(fieldMatches('*/15', 31, 0, 59)).toBe(false);
    expect(fieldMatches('0-30/10', 20, 0, 59)).toBe(true);
    expect(fieldMatches('0-30/10', 25, 0, 59)).toBe(false);
  });
});

describe('cronMatches', () => {
  it('matches the daily 03:00 schedule', () => {
    expect(cronMatches('0 3 * * *', new Date('2024-06-03T03:00:00Z'))).toBe(true);
    expect(cronMatches('0 3 * * *', new Date('2024-06-03T03:01:00Z'))).toBe(false);
    expect(cronMatches('0 3 * * *', new Date('2024-06-03T04:00:00Z'))).toBe(false);
  });

  it('matches the Monday 06:00 weekly schedule', () => {
    // 2024-06-03 is a Monday.
    expect(cronMatches('0 6 * * 1', new Date('2024-06-03T06:00:00Z'))).toBe(true);
    expect(cronMatches('0 6 * * 1', new Date('2024-06-04T06:00:00Z'))).toBe(false);
  });

  it('treats day-of-month and day-of-week as an OR when both are restricted', () => {
    // The 15th OR a Friday.
    expect(cronMatches('0 0 15 * 5', new Date('2024-06-15T00:00:00Z'))).toBe(true); // Saturday the 15th
    expect(cronMatches('0 0 15 * 5', new Date('2024-06-14T00:00:00Z'))).toBe(true); // Friday the 14th
    expect(cronMatches('0 0 15 * 5', new Date('2024-06-13T00:00:00Z'))).toBe(false);
  });

  it('returns false for invalid expressions instead of throwing', () => {
    expect(cronMatches('not a cron', new Date())).toBe(false);
  });
});

describe('minuteKey', () => {
  it('buckets by minute so a job cannot double-run inside one minute', () => {
    const a = minuteKey(new Date('2024-06-03T03:00:10Z'));
    const b = minuteKey(new Date('2024-06-03T03:00:55Z'));
    const c = minuteKey(new Date('2024-06-03T03:01:00Z'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('didMissSchedule', () => {
  it('reports a miss when the worker was asleep over the scheduled minute', () => {
    const now = new Date('2024-06-03T05:00:00Z');
    const since = new Date('2024-06-02T05:00:00Z');
    // Daily run at 03:00 falls inside the gap.
    expect(didMissSchedule('0 3 * * *', since, now)).toBe(true);
  });

  it('reports no miss when the slot already ran', () => {
    const now = new Date('2024-06-03T05:00:00Z');
    const since = new Date('2024-06-03T03:00:30Z');
    expect(didMissSchedule('0 3 * * *', since, now)).toBe(false);
  });

  it('treats a missing last-run timestamp as a miss', () => {
    expect(didMissSchedule('0 3 * * *', null, new Date('2024-06-03T05:00:00Z'))).toBe(true);
  });

  it('handles the weekly schedule', () => {
    // 2024-06-03 is Monday; a check on Tuesday should see Monday's 06:00 slot.
    const now = new Date('2024-06-04T02:00:00Z');
    const since = new Date('2024-05-27T06:00:30Z');
    expect(didMissSchedule('0 6 * * 1', since, now)).toBe(true);
  });
});

describe('nextRunAfter', () => {
  it('finds the next matching minute', () => {
    const next = nextRunAfter('0 3 * * *', new Date('2024-06-03T04:00:00Z'));
    expect(next?.toISOString()).toBe('2024-06-04T03:00:00.000Z');
  });

  it('finds the next weekly occurrence', () => {
    const next = nextRunAfter('0 6 * * 1', new Date('2024-06-04T00:00:00Z'));
    expect(next?.toISOString()).toBe('2024-06-10T06:00:00.000Z');
  });

  it('returns null for an impossible schedule', () => {
    expect(nextRunAfter('0 0 30 2 *', new Date('2024-06-03T00:00:00Z'), 60 * 24 * 400)).toBeNull();
  });
});

describe('describeCron', () => {
  it('renders friendly descriptions for the default schedules', () => {
    expect(describeCron('0 3 * * *')).toBe('daily at 03:00 UTC');
    expect(describeCron('0 6 * * 1')).toBe('Mondays at 06:00 UTC');
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(describeCron('7 4 * * *')).toBe('7 4 * * *');
  });
});
