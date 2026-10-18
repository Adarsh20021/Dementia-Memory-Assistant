// Runs a Python script with the face-service virtual environment.
import { pythonCmd, run } from './common.mjs';
const py = pythonCmd();
if (!py) {
  console.error('Python not found. Run npm run setup first.');
  process.exit(1);
}
run(py[0], [...py[1], ...process.argv.slice(2)]);
