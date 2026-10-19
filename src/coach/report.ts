import { z } from 'zod';

/**
 * "Analyse with AI": after a camera workout the TV sends the workout's numbers — never video,
 * pictures or body points — and Claude on Amazon Bedrock writes a short report.
 */

/** One attempt as the phone judged it. */
const Attempt = z.object({
  set: z.number().int().min(0).max(20),
  verdict: z.enum(['good', 'fix', 'no-rep']),
  counted: z.boolean(),
  faults: z.array(z.string().max(40)).max(6),
  /** The coach's first cue: why it didn't count, or what to fix. */
  reason: z.string().max(140).optional(),
  /** The move's measure at the deepest point, in degrees (see MEASURE). */
  bottomDeg: z.number().min(0).max(200).optional(),
  durationMs: z.number().min(0).max(60_000).optional(),
});

export const AnalysisRequest = z.object({
  /** The live pairing session: only a TV mid-workout can ask, and only a few times. */
  code: z.string().regex(/^\d{6}$/),
  channel: z.string().regex(/^\/session\/[0-9a-f-]{36}$/),
  move: z.object({ id: z.string().regex(/^[a-z-]{2,40}$/), name: z.string().min(1).max(40) }),
  plan: z.object({ sets: z.number().int().min(1).max(10), reps: z.number().int().min(1).max(50) }),
  seconds: z.number().min(0).max(7200),
  attempts: z.array(Attempt).max(300),
  /** Earlier sessions of the same move on this TV, newest first. */
  previous: z
    .array(
      z.object({
        daysAgo: z.number().int().min(0).max(400),
        reps: z.number().int().min(0).max(1000),
        cleanReps: z.number().int().min(0).max(1000).optional(),
        seconds: z.number().min(0).max(7200),
      }),
    )
    .max(8),
});
export type AnalysisRequest = z.infer<typeof AnalysisRequest>;

/** What the TV shows, section by section. */
export const Report = z.object({
  headline: z.string(),
  coachNote: z.string(),
  howItWent: z.string(),
  numbers: z.array(z.object({ title: z.string(), detail: z.string() })),
  comparedWithLastTime: z.string(),
  nextSession: z.object({ plan: z.string(), drill: z.string() }),
});
export type Report = z.infer<typeof Report>;

/** What `bottomDeg` means for each family of moves. */
function measureFor(moveId: string): string {
  if (moveId.includes('push-up')) return "the elbow angle at the bottom of the rep: smaller means the chest went closer to the floor (about 90° or less is a full push-up)";
  if (moveId.includes('jack')) return '180 minus the arm angle at the top: smaller means the arms went higher overhead';
  if (moveId === 'glute-bridge') return '180 minus the hip angle at the top: smaller means the hips lifted higher (0° is a straight line from shoulders to knees)';
  return 'the knee angle at the bottom of the rep: smaller means deeper (about 90° is thighs level with the floor; 180° is standing)';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (n: number | null) => (n === null ? null : Math.round(n));

/**
 * Per-set numbers worked out in code, so the model reads facts instead of doing arithmetic on
 * a list of attempts: counts, typical depth and pace, and the most common form notes.
 */
export function workoutFacts(req: AnalysisRequest) {
  const sets = Array.from({ length: req.plan.sets }, (_, set) => {
    const attempts = req.attempts.filter((a) => a.set === set);
    const depths = attempts.flatMap((a) => (a.bottomDeg === undefined ? [] : [a.bottomDeg]));
    const times = attempts.flatMap((a) => (a.durationMs === undefined ? [] : [a.durationMs / 1000]));
    return {
      set: set + 1,
      attempts: attempts.length,
      counted: attempts.filter((a) => a.counted).length,
      clean: attempts.filter((a) => a.verdict === 'good').length,
      noReps: attempts.filter((a) => !a.counted).length,
      typicalDepthDeg: round(median(depths)),
      depthRangeDeg: depths.length ? [Math.round(Math.min(...depths)), Math.round(Math.max(...depths))] : null,
      typicalRepSeconds: times.length ? Math.round(median(times)! * 10) / 10 : null,
    };
  });
  const notes = new Map<string, { count: number; firstAttempt: number }>();
  req.attempts.forEach((a, i) => {
    const said = a.reason ?? (a.faults[0] ? a.faults[0].replace(/-/g, ' ') : undefined);
    if (!said || a.verdict === 'good') return;
    const seen = notes.get(said);
    notes.set(said, { count: (seen?.count ?? 0) + 1, firstAttempt: seen?.firstAttempt ?? i + 1 });
  });
  const counted = req.attempts.filter((a) => a.counted).length;
  return {
    move: req.move.name,
    measure: measureFor(req.move.id),
    planned: `${req.plan.sets} sets of ${req.plan.reps}`,
    minutes: Math.round(req.seconds / 6) / 10,
    totals: {
      attempts: req.attempts.length,
      counted,
      clean: req.attempts.filter((a) => a.verdict === 'good').length,
      plannedReps: req.plan.sets * req.plan.reps,
    },
    sets,
    formNotes: [...notes.entries()].map(([note, v]) => ({ note, times: v.count, firstAtAttempt: v.firstAttempt })).sort((a, b) => b.times - a.times),
    previousSessions: req.previous,
  };
}

export const SYSTEM_PROMPT = `You are the coach inside Spotter, a workout app on a Fire TV. A phone's camera judged every rep of one exercise; you write the short report the person reads on their TV from the sofa, right after the workout.

What you get is numbers only: reps, verdicts, depth, pace and form notes the camera recorded, plus earlier sessions of the same move. You never see the person.

How to write:
- Talk to the person directly ("you"), warm and honest, like a good personal trainer. No hype, no emojis, no markdown.
- Use only what the numbers show. Quote a few of them (reps, degrees, seconds) so it feels specific. Never invent reps, sessions or trends that aren't in the data. If there's too little data to say something, say so plainly.
- "clean" means counted with good form; "fix" means counted with a note; "no-rep" didn't count. Spotter never counts a rep that doesn't meet the standard; don't soften that.
- Short sentences, everyday words. This is read across a room.
- No medical or injury diagnosis. If something looks like pain or strain might be involved (for example very slow, uneven reps), suggest taking it easier rather than diagnosing.

Fields:
- headline: at most 6 words, the one thing to remember.
- coachNote: 1–2 sentences, the coach's overall word.
- howItWent: 2 sentences on the session as a whole.
- numbers: 2 to 4 findings from the data, each a short title (2–4 words) and one sentence. Look at: depth consistency across sets, whether later sets got shallower or faster (tiredness), pace, the most common form note and when it started.
- comparedWithLastTime: 1–2 sentences comparing with the earlier sessions given (previousSessions, newest first). Earlier sessions only record reps, clean reps and how long they took: compare only those (more or fewer reps, a higher or lower share of clean reps), never depth or pace, which aren't recorded for them. If there are none, say this is the first one on record and what to beat next time.
- nextSession.plan: one concrete plan (sets × reps, or switching to the easier or harder version of the move), with the reason in a few words.
- nextSession.drill: one simple drill or cue to fix the main issue, in one sentence.`;

export function userMessage(req: AnalysisRequest): string {
  return `Here is the workout, as JSON:\n${JSON.stringify(workoutFacts(req))}\n\nEvery attempt in order (set is 0-based):\n${JSON.stringify(
    req.attempts.map(({ set, verdict, bottomDeg, durationMs, reason }) => ({ set, verdict, deg: round(bottomDeg ?? null), sec: durationMs === undefined ? null : Math.round(durationMs / 100) / 10, note: reason ?? null })),
  )}`;
}
