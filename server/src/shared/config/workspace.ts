import { resolve } from "node:path";

export function appDirectory(repository: string): string {
  return resolve(process.env["HEDGE_APP_DIR"] || resolve(repository, "packages/nextjs"));
}

export function deploymentDirectory(app: string): string {
  return resolve(process.env["HEDGE_DEPLOYMENT_ROOT"] || app);
}
