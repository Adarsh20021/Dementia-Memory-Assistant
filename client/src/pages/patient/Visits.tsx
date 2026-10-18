/** Patient: who is coming, and plan a visit. */
import { useAuth } from '../../auth/AuthContext';
import { Schedule } from '../../components/Schedule';

export default function Visits() {
  const { patient } = useAuth();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl">Visits</h1>
      <p className="text-sub">See who is coming, or add a visit. Your caregiver can see these too.</p>
      <Schedule patientId={patient!.id} mode="patient" />
    </div>
  );
}
