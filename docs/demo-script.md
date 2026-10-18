# Demo script (about 10 minutes, no real patients)

**Cast:** three volunteers (classmates) play the three fictional familiar people from the seed data: **Priya** (daughter), **Arjun** (grandson) and **Meera** (neighbour). One laptop plays both the caregiver and the patient. Use two browser windows, or a second device over HTTPS.

## Before the demo (once)

1. Run `npm run setup`, then `npm run seed`. Note the caregiver login `demo@example.com` / `DemoCare123`.
2. Run `npm run dev` and open http://localhost:5173 → **I am a caregiver** → sign in.
3. **Ravi → People → Priya:** with the volunteer's written OK, take 3–5 photos with **Use the camera**. Have them turn slightly left and right, and take some near a window. Repeat for Arjun and Meera.
4. **Add memory:** choose Priya, type the notes "came sunday, brought mangoes, looked at wedding album", then **Draft a summary with AI**. Edit the draft, then click **Approve and save**. Without a Groq key, just type the sentence yourself.

## Live demo

| # | Show | Say |
|---|---|---|
| 1 | Caregiver **People → Priya → Consent** | "No face data exists until consent is recorded: who agreed, when, and for what. Withdrawing it deletes the photos and face data immediately." |
| 2 | **Settings → Create pairing code**. In a second (private) window: **Set up this device for the patient** → enter the code | "The patient never needs a password. One code, once." |
| 3 | Patient screen: big text, one big button, "Ask my caregiver" always visible | Explain the dementia-friendly design: 20 px+ text, high contrast, 56 px buttons, no timeouts, calm colours. |
| 4 | Priya stands in front of the camera and turns her head slowly → **Who is this?** | It says aloud: "This is Priya, your daughter. She brought mangoes and you looked at your wedding album." |
| 5 | Hold a **printed photo** of Arjun up to the camera → **Who is this?** | It asks the visitor to turn their head and **does not reveal a name**. This is the liveness check. |
| 6 | A non-enrolled classmate → **Who is this?** | "I don't recognize this person. Please ask your caregiver." It never guesses. |
| 7 | Ask the question box: "When did Priya last visit?" | Answered from the database. Groq only rephrases. |
| 8 | **Add a memory about Priya** → type or speak → **Save → Yes, save it** | "Patient entries are saved immediately but marked for review." |
| 9 | Caregiver **Review** → correct the text → approve. Open **Timeline** → version history | "The original patient wording is kept." |
| 10 | Caregiver **Overview** and **Evaluation** | Latency numbers, fallback rate, CSV export, the SUS form. |
| 11 | **Audit log** | Every consent, enrollment and review action is recorded, with no content. |
| 12 | Unplug the network or stop Groq | Still works: the built-in sentence "This is Priya, your daughter. They last visited on …" |

## After the demo

On **Settings**, use **Delete all data**, or withdraw each volunteer's consent. Their photos and face data are deleted, which you can show in the audit log.
