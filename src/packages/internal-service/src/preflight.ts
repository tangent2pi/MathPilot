import {
  InternalServiceConfigurationError,
  validateInternalDeploymentConfiguration,
} from "./config.ts";

try {
  validateInternalDeploymentConfiguration(process.env);
  process.stdout.write("MathPilot internal service identity preflight passed\n");
} catch (error) {
  const detail = error instanceof InternalServiceConfigurationError ? `: ${error.message}` : "";
  process.stderr.write(`MathPilot internal service identity preflight failed${detail}\n`);
  process.exitCode = 1;
}
