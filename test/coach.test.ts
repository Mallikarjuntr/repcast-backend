import { describe, expect, it } from 'vitest';
import { AnalysisRequest, userMessage, workoutFacts } from '../src/coach/report.js';

const attempt = (set: number, verdict: 'good' | 'fix' | 'no-rep', bottomDeg: number, durationMs: number, reason?: string) => ({
  set,
  verdict,
  counted: verdict !== 'no-rep',
  faults: verdict === 'good' ? [] : ['knees-caving'],
  bottomDeg,
  durationMs,
  ...(reason ? { reason } : {}),
});

const workout = {
  code: '472913',
  channel: '/session/0b8d4a5e-3c1f-4a7e-9a40-2f6a3b9e1c22',
  move: { id: 'squat', name: 'Squats' },
  plan: { sets: 2, reps: 3 },
  seconds: 95,
  attempts: [
    attempt(0, 'good', 70, 2100),
    attempt(0, 'good', 74, 2000),
    attempt(0, 'fix', 98, 1800, 'Push your knees out'),
    attempt(1, 'fix', 105, 1500, 'Push your knees out'),
    attempt(1, 'no-rep', 128, 1200, "Not deep enough — that one doesn't count"),
    attempt(1, 'good', 88, 1900),
  ],
  previous: [{ daysAgo: 2, reps: 30, cleanReps: 24, seconds: 300 }],
};

describe('analysis request', () => {
  it('accepts a workout from the TV', () => {
    expect(AnalysisRequest.safeParse(workout).success).toBe(true);
  });

  it('rejects anything that is not a live pairing session', () => {
    expect(AnalysisRequest.safeParse({ ...workout, channel: '/other/thing' }).success).toBe(false);
    expect(AnalysisRequest.safeParse({ ...workout, code: '12345' }).success).toBe(false);
  });

  it('caps sizes, so one request cannot be made expensive', () => {
    const many = Array.from({ length: 301 }, () => attempt(0, 'good', 80, 2000));
    expect(AnalysisRequest.safeParse({ ...workout, attempts: many }).success).toBe(false);
    expect(AnalysisRequest.safeParse({ ...workout, move: { id: 'squat', name: 'x'.repeat(41) } }).success).toBe(false);
  });
});

describe('workout facts', () => {
  const facts = workoutFacts(AnalysisRequest.parse(workout));

  it('works out each set: counts, typical depth and pace', () => {
    expect(facts.sets[0]).toMatchObject({ set: 1, attempts: 3, counted: 3, clean: 2, noReps: 0, typicalDepthDeg: 74, depthRangeDeg: [70, 98], typicalRepSeconds: 2 });
    expect(facts.sets[1]).toMatchObject({ set: 2, attempts: 3, counted: 2, clean: 1, noReps: 1, typicalDepthDeg: 105, typicalRepSeconds: 1.5 });
  });

  it('ranks form notes and says when each started', () => {
    expect(facts.formNotes[0]).toEqual({ note: 'Push your knees out', times: 2, firstAtAttempt: 3 });
  });

  it('works out the totals and the change since last time, so the model never counts', () => {
    expect(facts.totals).toMatchObject({ attempts: 6, counted: 5, clean: 3, withANote: 2, noReps: 1, cleanPercentOfCounted: 60 });
    // Last time: 30 reps, 24 clean (80%). Today: 5 counted, 3 clean (60%).
    expect(facts.vsLastTime).toEqual({ daysAgo: 2, lastReps: 30, todayReps: 5, repsChange: -25, lastCleanPercent: 80, todayCleanPercent: 60, cleanPercentChange: -20 });
    const same = workoutFacts(AnalysisRequest.parse({ ...workout, previous: [{ daysAgo: 1, reps: 5, cleanReps: 3, seconds: 90 }] }));
    expect(same.vsLastTime).toMatchObject({ repsChange: 0, cleanPercentChange: 0 });
    expect(workoutFacts(AnalysisRequest.parse({ ...workout, previous: [] })).vsLastTime).toBeNull();
  });

  it('explains what the degrees mean for the move', () => {
    expect(facts.measure).toMatch(/knee angle/);
    expect(workoutFacts(AnalysisRequest.parse({ ...workout, move: { id: 'push-up', name: 'Push-ups' } })).measure).toMatch(/elbow/);
    expect(workoutFacts(AnalysisRequest.parse({ ...workout, move: { id: 'jumping-jack', name: 'Jumping jacks' } })).measure).toMatch(/arm/);
  });
});

describe('what goes to Bedrock', () => {
  it('carries the numbers but not the pairing code or channel', () => {
    const message = userMessage(AnalysisRequest.parse(workout));
    expect(message).toContain('Squats');
    expect(message).toContain('"deg":128');
    expect(message).not.toContain('472913');
    expect(message).not.toContain('/session/');
  });
});
