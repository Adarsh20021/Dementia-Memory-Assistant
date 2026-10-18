/** Caregiver: plan visits for the patient and see what the patient planned. */
import { useParams } from 'react-router-dom';
import { Schedule } from '../../components/Schedule';

export default function VisitsPage() {
  const { patientId } = useParams();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sub">
        Planned visits show on the patient's home screen, and they can ask "When is Priya coming?".
      </p>
      <Schedule patientId={patientId!} mode="caregiver" />
    </div>
  );
}
