import { loadApiNextSecurityConfig } from "./security-config.ts";

try {
  const config = loadApiNextSecurityConfig(process.env);
  if (config.environment !== "production") throw new Error("production profile required");
} catch {
  console.error("api-next production security preflight failed");
  process.exitCode = 1;
}
