/** Small lookups shared by routes that show "who is this about". */
import type { Types } from 'mongoose';
import { Person, hasActiveConsent } from '../models/person.model';
import { firstNameOf } from './context.service';

export interface PersonLabel {
  name: string;
  relationship: string;
}

/**
 * id -> { first name, relationship } for the given person ids of one patient.
 * People whose consent was withdrawn are still labelled (by first name only),
 * so old entries keep showing who they were about.
 */
export async function personLabels(
  patientId: Types.ObjectId | string,
  ids: (Types.ObjectId | string | undefined | null)[],
): Promise<Map<string, PersonLabel>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const people = await Person.find({ _id: { $in: unique }, patientId })
    .select('name relationship')
    .lean();
  return new Map(
    people.map((p) => [String(p._id), { name: firstNameOf(p.name), relationship: p.relationship }]),
  );
}

/** People the patient may see in pickers: active and with recorded consent. */
export async function directory(patientId: Types.ObjectId | string) {
  const people = await Person.find({ patientId, isActive: true });
  return people.filter(hasActiveConsent).map((p) => ({
    id: String(p._id),
    name: firstNameOf(p.name),
    relationship: p.relationship,
    hasPhoto: p.photos.length > 0,
  }));
}
