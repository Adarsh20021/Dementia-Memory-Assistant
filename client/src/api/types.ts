export type Role = 'caregiver' | 'patient';

export interface User {
  id: string;
  name: string;
  email?: string;
  role: Role;
}

export interface Preferences {
  language: string;
  fontScale: number;
  voiceRate: number;
}

export interface Patient {
  id: string;
  name: string;
  dob?: string;
  preferences: Preferences;
  settings: { retentionDays: number };
  pinEnabled?: boolean;
}

export type ConsentScope = 'recognition' | 'visit-history' | 'conversation-summaries';

export interface Consent {
  given: boolean;
  givenBy?: string;
  givenByRole?: 'person' | 'caregiver';
  reason?: string;
  givenAt?: string;
  scope: ConsentScope[];
  revokedAt?: string;
}

export interface Person {
  id: string;
  patientId: string;
  name: string;
  relationship: string;
  age?: number;
  notes?: string;
  photoCount: number;
  photos: { id: string; addedAt: string }[];
  enrolledFaceCount: number;
  isActive: boolean;
  hasActiveConsent: boolean;
  consent: Consent;
}

export type Outcome = 'match' | 'unsure' | 'unknown' | 'no_face' | 'liveness_failed';

export interface RecognitionResult {
  eventId: string;
  outcome: Outcome;
  message: string;
  score?: number;
  visitId?: string;
  needsCaregiverConfirmation?: boolean;
  person?: { id: string; name: string; relationship: string; photoUrl: string | null };
}

export interface Note {
  id: string;
  kind: 'note' | 'reminder';
  text: string;
  dueAt?: string;
  completed: boolean;
  personId?: string;
  personName?: string;
  mine: boolean;
  createdAt: string;
}

export interface Memory {
  id: string;
  personId?: string;
  personName?: string;
  relationship?: string;
  visitId?: string;
  summary: string;
  source: 'caregiver' | 'ai-summary' | 'patient';
  authorId: string;
  mine: boolean;
  reviewStatus: 'pending' | 'approved' | 'flagged';
  consentApproved: boolean;
  version: number;
  createdAt: string;
  editedAt?: string;
  history?: { version: number; summary: string; editedAt: string }[];
}

export interface Visit {
  id: string;
  personId: string;
  personName?: string;
  timestamp: string;
  matchConfidence?: number;
  outcome: 'match' | 'unsure' | 'manual';
  needsConfirmation: boolean;
  confirmedByCaregiver?: boolean;
}

export interface Overview {
  patient: Patient;
  counts: {
    people: number;
    enrolled: number;
    pendingReviews: number;
    unsureVisits: number;
    openHelpRequests: number;
  };
  recentEvents: {
    id: string;
    timestamp: string;
    outcome: string;
    score?: number;
    personName?: string;
    summarySource?: string;
  }[];
  unsureVisits: Visit[];
  pendingReviews: { id: string; summary: string; personName?: string; createdAt: string }[];
  openHelpRequests: { id: string; context?: string; createdAt: string }[];
  lowConfidence: {
    personId: string;
    name: string;
    recognitions: number;
    unsureCount: number;
    medianScore: number | null;
    photoCount: number;
  }[];
  thresholds: { match: number; unsure: number };
  upcomingVisits: ScheduledVisit[];
  setup: {
    addedPerson: boolean;
    addedPhotos: boolean;
    deviceReady: boolean;
    plannedVisit: boolean;
    addedMemory: boolean;
  };
}

export interface ScheduledVisit {
  id: string;
  personId?: string;
  personName?: string;
  relationship?: string;
  visitorName?: string;
  /** Display name: the person's first name or the typed visitor name. */
  who: string;
  startsAt: string;
  durationMin?: number;
  note?: string;
  status: 'scheduled' | 'cancelled' | 'done';
  createdByRole: Role;
  mine: boolean;
}

/** A familiar person as the patient may see them (first name only). */
export interface DirectoryPerson {
  id: string;
  name: string;
  relationship: string;
  hasPhoto: boolean;
}

export interface PersonStory {
  person: { id: string; name: string; relationship: string; photoUrl: string | null };
  nextVisit: { id: string; startsAt: string; when: string } | null;
  visits: { id: string; timestamp: string; date: string }[];
  memories: {
    id: string;
    summary: string;
    source: 'caregiver' | 'ai-summary' | 'patient';
    mine: boolean;
    reviewStatus: 'pending' | 'approved' | 'flagged';
    canRetell: boolean;
    createdAt: string;
    date: string;
  }[];
}

export interface AskResponse {
  answer: string;
  summary?: string;
  summarySource?: 'llm' | 'none';
  found: boolean;
  personId?: string;
}

export interface SystemStatus {
  ai: {
    configured: boolean;
    enabled: boolean;
    model: string;
    dailyLimit: number;
    today: { calls: number; failures: number };
    lastCall: { at: string; ok: boolean; reason?: string; httpStatus?: number; detail?: string } | null;
  };
  face: {
    reachable: boolean;
    secretSet: boolean;
    url: string;
    modelsLoaded: boolean;
    problem?: 'secret_mismatch' | 'models_not_loaded' | 'not_running';
  };
}
