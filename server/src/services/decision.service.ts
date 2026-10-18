/**
 * Recognition decision logic (pure, unit-tested).
 *
 * Input: per-frame results from the face service (best candidate + score).
 * Rules:
 *  1. A frame "votes" for a person when it has a face, its best score is at
 *     least UNSURE, and it beats the runner-up by MARGIN (else ambiguous).
 *  2. A person needs at least REQUIRED votes out of the frames sent
 *     (e.g. 3 of 5) before we say anything. One lucky frame never names anyone.
 *  3. The decision score is the MEDIAN of that person's voting frames:
 *        median >= MATCH   -> "match"   (say who it is)
 *        median >= UNSURE  -> "unsure"  ("This may be ...", caregiver confirms)
 *  4. Otherwise "unknown" ("I don't recognize this person"). We never guess.
 *  5. Liveness ("motion" mode): a real head moves in 3D, so the nose/eye
 *     geometry (yaw ratio) changes across frames. A flat photo held up to the
 *     camera keeps it almost constant. If the range is below the minimum the
 *     outcome is "liveness_failed" and no identity is announced.
 */
import type { FrameAnalysis } from './faceClient.service';

export type Outcome = 'match' | 'unsure' | 'unknown' | 'no_face' | 'liveness_failed';

export interface DecisionConfig {
  matchThreshold: number;
  unsureThreshold: number;
  framesRequired: number;
  margin: number;
  livenessMode: 'motion' | 'off';
  livenessMinYawRange: number;
}

export interface Decision {
  outcome: Outcome;
  personId?: string;
  score?: number;
  framesTotal: number;
  framesWithFace: number;
  votes: number;
  liveness: { checked: boolean; passed: boolean; yawRange: number | null };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function decide(frames: FrameAnalysis[], cfg: DecisionConfig): Decision {
  const withFace = frames.filter((f) => f.faceFound);
  const yaws = withFace.map((f) => f.yaw).filter((y): y is number => typeof y === 'number');
  const yawRange = yaws.length >= 2 ? Math.max(...yaws) - Math.min(...yaws) : null;
  const livenessChecked = cfg.livenessMode === 'motion';
  const livenessPassed =
    !livenessChecked || (yawRange !== null && yawRange >= cfg.livenessMinYawRange);

  const base = {
    framesTotal: frames.length,
    framesWithFace: withFace.length,
    liveness: { checked: livenessChecked, passed: livenessPassed, yawRange },
  };

  if (withFace.length < cfg.framesRequired) {
    return { ...base, outcome: 'no_face', votes: 0 };
  }

  // Count votes per person.
  const votes = new Map<string, number[]>();
  for (const f of withFace) {
    if (!f.best || f.best.score < cfg.unsureThreshold) continue;
    if (f.second && f.best.score - f.second.score < cfg.margin) continue; // ambiguous frame
    const list = votes.get(f.best.id) ?? [];
    list.push(f.best.score);
    votes.set(f.best.id, list);
  }

  let top: { id: string; scores: number[] } | null = null;
  for (const [id, scores] of votes) {
    if (
      !top ||
      scores.length > top.scores.length ||
      (scores.length === top.scores.length && median(scores) > median(top.scores))
    ) {
      top = { id, scores };
    }
  }

  if (!top || top.scores.length < cfg.framesRequired) {
    return { ...base, outcome: 'unknown', votes: top?.scores.length ?? 0 };
  }

  const score = Math.round(median(top.scores) * 10000) / 10000;
  if (!livenessPassed) {
    // Do not reveal who it might be.
    return { ...base, outcome: 'liveness_failed', votes: top.scores.length, score };
  }
  return {
    ...base,
    outcome: score >= cfg.matchThreshold ? 'match' : 'unsure',
    personId: top.id,
    score,
    votes: top.scores.length,
  };
}
