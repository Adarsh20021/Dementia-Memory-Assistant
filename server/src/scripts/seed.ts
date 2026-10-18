/**
 * Demo seed data — FICTIONAL people only, so the app can be demoed without
 * real patients. Safe to run repeatedly (skips if the demo caregiver exists).
 *
 *   npm run seed
 *
 * Creates: caregiver demo@example.com / DemoCare123, patient "Ravi",
 * three familiar people with recorded consent, and prints a pairing code.
 * Face photos are NOT seeded: enroll your (consenting) demo volunteers through
 * the dashboard (People -> person -> Use the camera). See docs/demo-script.md.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Patient } from '../models/patient.model';
import { Person } from '../models/person.model';
import { User } from '../models/user.model';
import { issuePairingCode } from '../services/pairing.service';
import { encryptText } from '../lib/crypto';
import { Memory } from '../models/memory.model';
import { ScheduledVisit } from '../models/scheduledVisit.model';
import { hashPassword } from '../services/password.service';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'DemoCare123';

const PEOPLE = [
  {
    name: 'Priya',
    relationship: 'daughter',
    age: 42,
    notes: 'Visits on Sundays. Brings filter coffee.',
  },
  { name: 'Arjun', relationship: 'grandson', age: 16, notes: 'Plays chess with Ravi.' },
  {
    name: 'Meera',
    relationship: 'neighbour',
    age: 67,
    notes: 'Lives next door. Waters the garden.',
  },
];

const DEMO_PIN = '2580';
const p0 = (name: string) => name.split(/\s+/)[0];

async function main() {
  await mongoose.connect(env.MONGO_URI);

  if (await User.exists({ email: DEMO_EMAIL })) {
    console.log(`Demo data already exists. Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    return;
  }

  const caregiver = await User.create({
    name: 'Demo Caregiver',
    email: DEMO_EMAIL,
    passwordHash: await hashPassword(DEMO_PASSWORD),
    role: 'caregiver',
  });

  const patient = new Patient({ name: 'Ravi', caregiverIds: [caregiver._id] });
  const patientUser = await User.create({
    name: 'Ravi',
    role: 'patient',
    patientIds: [patient._id],
  });
  patient.patientUserId = patientUser._id;
  await patient.save();
  caregiver.patientIds.push(patient._id);
  await caregiver.save();

  const created = [];
  for (const p of PEOPLE) {
    const person = await Person.create({
      ...p,
      patientId: patient._id,
      consent: {
        given: true,
        givenBy: 'Demo Caregiver',
        givenByRole: 'caregiver',
        reason: 'Fictional demo person (seed data)',
        givenAt: new Date(),
        scope: ['recognition', 'visit-history', 'conversation-summaries'],
      },
    });
    created.push(person);
  }

  // A few approved memories and planned visits, so every screen has something to show.
  const [first, second] = created;
  const memoriesFor: [typeof first, string][] = [
    [
      first,
      `${p0(first.name)} brought homemade mango pickle and you looked at old wedding photos together.`,
    ],
    [first, `You and ${p0(first.name)} talked about the garden. The roses are blooming.`],
    [second, `${p0(second.name)} played a game of carrom with you and won one round.`],
  ];
  for (const [person, text] of memoriesFor) {
    await Memory.create({
      patientId: patient._id,
      personId: person._id,
      summaryEnc: encryptText(text),
      source: 'caregiver',
      authorId: caregiver._id,
      reviewStatus: 'approved',
      consentApproved: true,
      approvedBy: caregiver._id,
    });
  }
  const at = (days: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  await ScheduledVisit.create([
    {
      patientId: patient._id,
      personId: first._id,
      startsAt: at(1, 16),
      noteEnc: encryptText('Bringing lunch'),
      createdBy: caregiver._id,
      createdByRole: 'caregiver',
    },
    {
      patientId: patient._id,
      personId: second._id,
      startsAt: at(3, 11),
      createdBy: caregiver._id,
      createdByRole: 'caregiver',
    },
  ]);

  // Demo PIN, so a signed-out demo device can come back without a new code.
  await Patient.updateOne(
    { _id: patient._id },
    { $set: { 'pin.hash': await hashPassword(DEMO_PIN), 'pin.setAt': new Date() } },
  );

  const { code, expiresAt } = await issuePairingCode(patient._id, String(caregiver._id));
  console.log('Seeded demo data:');
  console.log(`  Caregiver login : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Patient         : Ravi (id ${patient._id})`);
  console.log(
    `  People          : ${PEOPLE.map((p) => `${p.name} (${p.relationship})`).join(', ')}`,
  );
  console.log(`  Pairing code    : ${code} (expires ${expiresAt.toLocaleTimeString()})`);
  console.log(`  Patient PIN     : ${DEMO_PIN} (on a device that was paired before)`);
  console.log('  Tip: or sign in as the caregiver on the patient device and use');
  console.log('       Settings > "Use this device for the patient" (no code needed).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
