import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const entry = fileURLToPath(import.meta.url);
const root = resolve(dirname(entry), "..");
const app = resolve(
  process.env["HEDGE_APP_DIR"] ||
    (process.cwd() === root ? join(root, "packages/nextjs") : process.cwd()),
);
const stateDir = join(app, ".hedge");
const managementScope = `manager:${hostname()}:${createHash("sha256").update(app).digest("hex")}`;
const names = ["server", "nextjs"] as const;
type ServiceName = (typeof names)[number];
type Service = { pid: number; runId: string; configHash: string; port: number; url: string };
type State = Partial<Record<ServiceName, Service>>;
let operationSignal: AbortSignal | undefined;
function checkInterrupted(): void {
  operationSignal?.throwIfAborted();
}

export function loadEnvironment(path = process.env["HEDGE_ENV_FILE"] ?? join(root, ".env")): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}
export function managerConfig(workspace = app) {
  const serverPort = Number(process.env["PORT"] ?? 3003);
  const frontendPort = Number(process.env["FRONTEND_PORT"] ?? 3002);
  const serverHost = process.env["HOST"] ?? "127.0.0.1";
  const frontendHost = process.env["FRONTEND_HOST"] ?? "127.0.0.1";
  for (const port of [serverPort, frontendPort])
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Configure valid, distinct service ports");
  if (serverPort === frontendPort) throw new Error("Configure distinct service ports");
  if (
    !["127.0.0.1", "0.0.0.0"].includes(serverHost) ||
    !["127.0.0.1", "0.0.0.0"].includes(frontendHost)
  )
    throw new Error("Service hosts must be 127.0.0.1 or 0.0.0.0");
  const localTest = process.env["HEDGE_LOCAL_TESTNET"] === "1";
  if (localTest && (serverHost !== "127.0.0.1" || frontendHost !== "127.0.0.1"))
    throw new Error("Local test-wallet services require loopback binding");
  const serverUrl = `http://127.0.0.1:${serverPort}`,
    frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(serverPort),
    HOST: serverHost,
    HEDGE_APP_DIR: workspace,
    HEDGE_DEPLOYMENT_ROOT: process.env["HEDGE_DEPLOYMENT_ROOT"] || root,
    HEDGE_DEPLOYMENT_FILE: "deployments/testnet.json",
    HEDGE_POLICY_FILE: process.env["HEDGE_POLICY_FILE"] || ".hedge/operator.json",
    NEXT_PUBLIC_SITE_URL: process.env["NEXT_PUBLIC_SITE_URL"] || frontendUrl,
    CORS_ORIGINS: process.env["CORS_ORIGINS"] || frontendUrl,
  };
  const configHash = createHash("sha256")
    .update(
      JSON.stringify({
        serverPort,
        frontendPort,
        serverHost,
        frontendHost,
        driver: environment["DATABASE_DRIVER"],
        database: environment["DATABASE_URL"],
        redis: environment["REDIS_URL"],
        localTest,
        app: "nextjs",
        origins: environment.CORS_ORIGINS,
        siteUrl: environment["NEXT_PUBLIC_SITE_URL"],
        maximumGasFee: environment["HEDGE_OPERATOR_MAX_FEE_HBAR"],
        minimumGasReserve: environment["HEDGE_OPERATOR_MIN_HBAR"],
        prefix: environment["REDIS_PREFIX"],
        config: environment["HEDGE_DEPLOYMENT_FILE"],
        configContents: existsSync(
          resolve(environment["HEDGE_DEPLOYMENT_ROOT"]!, environment["HEDGE_DEPLOYMENT_FILE"]!),
        )
          ? createHash("sha256")
              .update(
                readFileSync(
                  resolve(
                    environment["HEDGE_DEPLOYMENT_ROOT"]!,
                    environment["HEDGE_DEPLOYMENT_FILE"]!,
                  ),
                ),
              )
              .digest("hex")
          : "missing",
        publicConfig: existsSync(join(workspace, ".hedge/hedge.config.json"))
          ? createHash("sha256")
              .update(readFileSync(join(workspace, ".hedge/hedge.config.json")))
              .digest("hex")
          : "missing",
        operator: environment["HEDGE_OPERATOR_URL"],
        operatorAddress: process.env["HEDGE_OPERATOR_ADDRESS"],
        policy: environment["HEDGE_POLICY_FILE"],
        policyContents: existsSync(resolve(workspace, environment["HEDGE_POLICY_FILE"]!))
          ? createHash("sha256")
              .update(readFileSync(resolve(workspace, environment["HEDGE_POLICY_FILE"]!)))
              .digest("hex")
          : "missing",
      }),
    )
    .digest("hex");
  return {
    serverPort,
    frontendPort,
    serverHost,
    frontendHost,
    serverUrl,
    frontendUrl,
    environment,
    configHash,
    localTest,
  };
}
function privateDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error("Refusing symlinked management state");
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
async function readState(): Promise<State> {
  const { readRecord } = await import("../server/src/shared/database/records.js");
  const value = (await readRecord<State>(managementScope, "services")) ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid service state");
  for (const name of Object.keys(value))
    if (!names.includes(name as ServiceName)) throw new Error("Invalid service state");
  for (const service of Object.values(value)) {
    if (
      !service ||
      !Number.isSafeInteger(service.pid) ||
      service.pid <= 1 ||
      !/^[\da-f-]{36}$/.test(service.runId) ||
      !/^[\da-f]{64}$/.test(service.configHash) ||
      !Number.isInteger(service.port) ||
      service.port < 1 ||
      service.port > 65535 ||
      service.url !== `http://127.0.0.1:${service.port}`
    )
      throw new Error("Invalid service state");
  }
  return value;
}
async function saveState(value: State): Promise<void> {
  const { writeRecord } = await import("../server/src/shared/database/records.js");
  await writeRecord(managementScope, "services", value);
}
export function ownedProcess(service: Service): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(service.pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return (
      command.includes(entry) && command.includes(" internal ") && command.includes(service.runId)
    );
  } catch {
    return false;
  }
}
async function withLock<T>(action: () => Promise<T>): Promise<T> {
  privateDirectory(stateDir);
  const lock = join(stateDir, "manager.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (lstatSync(lock).isSymbolicLink())
      throw new Error("Refusing symlinked management lock", { cause: error });
    const owner = join(lock, "owner.json");
    if (!existsSync(owner))
      throw new Error("Another management operation is starting", { cause: error });
    const { pid } = JSON.parse(readFileSync(owner, "utf8")) as { pid: number };
    if (!Number.isSafeInteger(pid) || pid <= 1)
      throw new Error("Invalid management lock", { cause: error });
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) throw new Error("Another management operation is running", { cause: error });
    rmSync(lock, { recursive: true });
    mkdirSync(lock, { mode: 0o700 });
  }
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const controller = new AbortController();
  operationSignal = controller.signal;
  const interrupt = () =>
    controller.abort(new Error("Management interrupted; saved transactions can be resumed"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    return await action();
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    operationSignal = undefined;
    rmSync(lock, { recursive: true });
  }
}
async function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd = root,
): Promise<void> {
  checkInterrupted();
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit", detached: true });
    const interrupt = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
      }
    };
    operationSignal?.addEventListener("abort", interrupt, { once: true });
    const cleanup = () => operationSignal?.removeEventListener("abort", interrupt);
    child.once("error", (error) => {
      cleanup();
      fail(error);
    });
    child.once("exit", (code) => {
      cleanup();
      if (code === 0 && !operationSignal?.aborted) done();
      else fail(new Error(`${command} failed; no later step was run`));
    });
  });
}
async function verifyConfig() {
  const { loadPublicConfig } = await import("../server/src/shared/config/hedge-config.js");
  const { EvmHedgeReader, createAccountResolver } = await import("@hedge/sdk");
  const config = loadPublicConfig(app);
  const reader = new EvmHedgeReader({
    manifest: config.deployment,
    rpc: config.rpc,
    startBlock: {
      hedera: BigInt(config.start_block.hedera),
      base: BigInt(config.start_block.base),
    },
    resolveAccount: createAccountResolver(config.mirror_url),
  });
  console.log("Verifying deployed contracts and frozen configuration…");
  await reader.verifyDeployment();
  console.log(`Deployment verified: ${config.deployment.instance_id}`);
  return { config, reader };
}
async function portOccupied(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (occupied: boolean) => {
      socket.destroy();
      done(occupied);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
async function waitForService(name: ServiceName, service: Service): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    checkInterrupted();
    if (!ownedProcess(service))
      throw new Error(`${name} exited during startup; use npm run hedge -- logs ${name}`);
    try {
      const response = await fetch(service.url + (name === "server" ? "/ready" : "/"), {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        if (name === "server") {
          const body = (await response.json()) as { scope?: string; ok?: boolean };
          if (body.scope !== "infrastructure" || body.ok !== true)
            throw new Error("Unexpected server readiness response");
        }
        return;
      }
    } catch {
      /* Service or configured database is still starting. */
    }
    await delay(250);
  }
  throw new Error(`${name} did not become ready; use npm run hedge -- logs ${name}`);
}
function spawnService(name: ServiceName, config: ReturnType<typeof managerConfig>): Service {
  const runId = randomUUID();
  const child = spawn(process.execPath, ["--import", "tsx", entry, "internal", name, runId], {
    cwd: root,
    env: { ...config.environment, HEDGE_MANAGED_RUN_ID: runId },
    detached: true,
    stdio: "ignore",
  });
  if (!child.pid) throw new Error(`Could not start ${name}`);
  child.on("error", () => undefined);
  child.unref();
  return {
    pid: child.pid,
    runId,
    configHash: config.configHash,
    port: name === "server" ? config.serverPort : config.frontendPort,
    url: name === "server" ? config.serverUrl : config.frontendUrl,
  };
}
async function stopService(service: Service): Promise<void> {
  if (!ownedProcess(service)) return;
  process.kill(-service.pid, "SIGTERM");
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!ownedProcess(service)) return;
    await delay(250);
  }
  if (ownedProcess(service)) process.kill(-service.pid, "SIGKILL");
}
async function stop(): Promise<void> {
  const state = await readState();
  for (const name of [...names].reverse()) {
    if (state[name]) await stopService(state[name]);
    delete state[name];
    await saveState(state);
  }
  console.log("Hedge services stopped.");
}
async function start(): Promise<void> {
  const config = managerConfig();
  Object.assign(process.env, config.environment);
  const { assertServerConfig, env, localTestOrigins } = await import(
    "../server/src/shared/config/env.js"
  );
  assertServerConfig();
  if (env.databaseDriver === "none")
    throw new Error("Configure DATABASE_DRIVER and DATABASE_URL in .env");
  if (config.localTest) localTestOrigins();
  const state = await readState();
  for (const name of names) {
    const service = state[name];
    if (service && ownedProcess(service)) {
      if (service.configHash !== config.configHash)
        throw new Error("Service configuration changed; run npm run hedge -- restart");
    } else {
      delete state[name];
      if (await portOccupied(name === "server" ? config.serverPort : config.frontendPort))
        throw new Error(`${name} port is occupied by an unmanaged process; configure another port`);
    }
  }
  if (!Object.keys(state).length) {
    console.log("Building packages, server and Next.js…");
    await run("npm", ["run", "build:packages"], config.environment);
  }
  const { loadOperatorPolicy } = await import("../server/src/features/operator/quote-policy.js");
  await loadOperatorPolicy(app);
  const { config: publicConfig } = await verifyConfig();
  if (config.localTest && publicConfig.operator_url !== `${config.serverUrl}/testnet`)
    throw new Error("Set operator_url in hedge.config.json to the local server's /testnet URL");
  checkInterrupted();
  if (!Object.keys(state).length) {
    await run("npm", ["run", "build", "--workspace", "@hedge/server"], config.environment);
    await run("npm", ["run", "build", "--workspace", "@hedge/nextjs"], config.environment);
  }
  const started: ServiceName[] = [];
  try {
    for (const name of names) {
      checkInterrupted();
      if (!state[name]) {
        state[name] = spawnService(name, config);
        started.push(name);
        await saveState(state);
      }
      await waitForService(name, state[name]);
    }
  } catch (error) {
    for (const name of started.reverse()) {
      await stopService(state[name]!);
      delete state[name];
    }
    await saveState(state);
    throw error;
  }
  console.log(
    `Server: ${config.serverUrl} (infrastructure ready; database: ${env.databaseDriver})`,
  );
  console.log(`Demo: ${config.frontendUrl}/demo`);
  console.log(
    config.localTest
      ? "Mode: loopback testnet with local test wallets"
      : "Mode: platform HTTP foundation; public offer/relay services still require implementation",
  );
}
async function deploy(): Promise<void> {
  const config = managerConfig();
  if (Object.values(await readState()).some(ownedProcess))
    throw new Error("Stop managed services before deploying or rebuilding contracts");
  const environment = {
    ...config.environment,
    HEDGE_TESTNET_RUN: "fast",
    HEDGE_OPERATOR_URL: process.env["HEDGE_OPERATOR_URL"] ?? `${config.serverUrl}/testnet`,
  };
  if (config.environment["HEDGE_DEPLOYMENT_FILE"] !== "deployments/testnet.json")
    throw new Error("Testnet deployment writes deployments/testnet.json");
  await run("npm", ["run", "build:contracts"], environment);
  await run("npm", ["run", "codegen"], environment);
  await run("npm", ["run", "build:packages"], environment);
  const { deploymentKey } = await import("./deployment.js");
  const { readRecord, writeRecord } = await import("../server/src/shared/database/records.js");
  const { readWallets } = await import("../server/src/shared/config/wallets.js");
  const wallets = readWallets(app);
  const scope = `deployment:${app}:${wallets.hedera.address.toLowerCase()}:${deploymentKey(root)}`;
  Object.assign(environment, { HEDGE_JOURNAL_SCOPE: scope, HEDGE_NODE: process.execPath });
  const complete = async (network: string, operation: string) =>
    (await readRecord<{ status: string }>(scope, `deploy-${network}-${operation}.json`))?.status ===
    "confirmed_success";
  const networks = ["hedera-testnet", "base-sepolia"];
  const fullyDeployed =
    (
      await Promise.all(
        networks.map(
          async (network) =>
            (await complete(network, "contract")) && (await complete(network, "peer")),
        ),
      )
    ).every(Boolean) && (await complete("hedera-testnet", "capital"));
  if (!fullyDeployed) {
    console.log(
      "Preparing testnet deployment. Existing signed operations resume their saved hashes.",
    );
    await init();
    await run("python3", [join(root, "scripts/testnet-chain.py")], environment);
    for (const network of networks)
      await run(
        "python3",
        [join(root, "scripts/testnet-deploy.py"), network, "contract"],
        environment,
      );
    if (!(await Promise.all(networks.map((network) => complete(network, "peer")))).some(Boolean))
      await run("python3", [join(root, "scripts/testnet-verify.py"), "unconfigured"], environment);
    for (const network of networks)
      await run("python3", [join(root, "scripts/testnet-deploy.py"), network, "peer"], environment);
    for (const operation of ["approve", "capital"])
      if (!(await complete("hedera-testnet", operation)))
        await run(
          "python3",
          [join(root, "scripts/testnet-deploy.py"), "hedera-testnet", operation],
          environment,
        );
  } else
    console.log(
      "Existing deployment is complete; verifying it without sending another transaction.",
    );
  await run("python3", [join(root, "scripts/testnet-verify.py"), "configured"], environment);
  const { saveDeployment, publishConfig, loadConfig } = await import("./deployment.js");
  const previousPath = join(root, "deployments/testnet.json");
  if (existsSync(previousPath)) {
    const previous = JSON.parse(readFileSync(previousPath, "utf8"));
    await writeRecord(
      scope,
      `previous:${createHash("sha256").update(JSON.stringify(previous)).digest("hex")}`,
      previous,
    );
  }
  saveDeployment(
    await readRecord(scope, "deployment.json"),
    join(root, "deployments/testnet.json"),
    environment.HEDGE_OPERATOR_URL,
  );
  const updated = loadConfig(previousPath);
  const configPath = join(app, ".hedge/hedge.config.json");
  if (existsSync(configPath)) {
    const { loadPublicConfig } = await import("../server/src/shared/config/hedge-config.js");
    const previous = loadPublicConfig(app);
    updated.operator = previous.operator;
    updated.operator_url = previous.operator_url;
  }
  publishConfig(updated, configPath);
  console.log(
    "Verified deployment and public contract configuration saved. Run npm run hedge -- start.",
  );
}
async function init(): Promise<void> {
  const { initialize } = await import("./initialize.js");
  const existingWallets = existsSync(join(app, ".hedge/wallets.json"));
  const wallets = await initialize(app);
  console.log(`Hedera operator: ${wallets.hedera.address}`);
  console.log(`Base relay: ${wallets.base.address}`);
  const path = join(app, ".hedge/hedge.config.json");
  if (existsSync(path)) {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    if (!existingWallets || !settings.operator) {
      settings.operator = wallets.hedera.address;
      writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    } else if (String(settings.operator).toLowerCase() !== wallets.hedera.address.toLowerCase()) {
      throw new Error("Set .hedge/hedge.config.json operator to the generated Hedera address");
    }
  }
  console.log(`Wallets: ${join(app, ".hedge/wallets.json")}`);
  console.log("Next: npm run hedge -- liquidity deposit AMOUNT, then npm run hedge -- start");
}
async function liquidity(args: string[]): Promise<void> {
  const { liquidityRequest, runLiquidity } = await import("./liquidity.js");
  const request = liquidityRequest(args);
  if (request.action !== "status" && Object.values(await readState()).some(ownedProcess))
    throw new Error(
      "Stop managed services before changing liquidity, then start them after confirmation",
    );
  const { config, reader } = await verifyConfig();
  await runLiquidity(app, reader, config.operator, request, checkInterrupted);
}
async function logs(name?: string): Promise<void> {
  if (name && !names.includes(name as ServiceName)) throw new Error("Choose server or nextjs logs");
  const { readRecord } = await import("../server/src/shared/database/records.js");
  for (const service of name ? [name] : names) {
    const log = await readRecord<string>(managementScope, `logs:${service}`);
    console.log(`${service}:\n${log ?? "No logs yet"}`);
  }
}
async function internal(name: string, runId: string): Promise<void> {
  if (
    !names.includes(name as ServiceName) ||
    !/^[\da-f-]{36}$/.test(runId) ||
    process.env["HEDGE_MANAGED_RUN_ID"] !== runId
  )
    throw new Error("Invalid managed service invocation");
  const config = managerConfig();
  const child =
    name === "server"
      ? spawn(process.execPath, [join(root, "server/dist/server.js")], {
          cwd: join(root, "server"),
          env: config.environment,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(
          process.execPath,
          [
            join(root, "node_modules/next/dist/bin/next"),
            "start",
            "--hostname",
            config.frontendHost,
            "--port",
            String(config.frontendPort),
          ],
          { cwd: app, env: config.environment, stdio: ["ignore", "pipe", "pipe"] },
        );
  const { writeRecord } = await import("../server/src/shared/database/records.js");
  let buffer = "",
    pending: Promise<void> = Promise.resolve();
  const flush = () => {
    const value = buffer;
    pending = pending.then(() => writeRecord(managementScope, `logs:${name}`, value));
    void pending.catch(() => {
      child.kill("SIGTERM");
    });
  };
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-64_000);
    });
  const timer = setInterval(flush, 500);
  timer.unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      child.kill(signal);
    });
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
      done();
    });
  });
  clearInterval(timer);
  flush();
  await pending;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  loadEnvironment();
  const [command = "start", ...rest] = args;
  if (command === "help" || command === "--help") {
    console.log(
      "npm run hedge -- init\nnpm run hedge -- liquidity [status|deposit AMOUNT|withdraw AMOUNT]\nnpm run hedge -- start|stop|restart|deploy|logs [server|nextjs]\nConfiguration: app/.hedge/{wallets,operator,hedge.config}.json and .env",
    );
    return;
  }
  if (command === "init") {
    if (rest.length) throw new Error("Use init; configure services in .env");
    await withLock(init);
    return;
  }
  if (command === "internal") {
    if (
      !names.includes(rest[0] as ServiceName) ||
      !/^[\da-f-]{36}$/.test(rest[1] ?? "") ||
      process.env["HEDGE_MANAGED_RUN_ID"] !== rest[1]
    )
      throw new Error("Invalid managed service invocation");
  } else if (command === "liquidity") {
    const { liquidityRequest } = await import("./liquidity.js");
    liquidityRequest(rest);
  } else if (command === "logs") {
    if (rest.length > 1 || (rest[0] && !names.includes(rest[0] as ServiceName)))
      throw new Error("Choose server or nextjs logs");
  } else {
    if (rest.length) throw new Error("Configure deployment and services through .env");
    if (!["start", "deploy", "stop", "restart"].includes(command))
      throw new Error("Unknown command; use npm run hedge -- help");
  }
  Object.assign(process.env, managerConfig().environment);
  if (command === "liquidity") await import("../server/src/features/operator/liquidity.repo.js");
  const { connectDatabase, closeDatabase } = await import(
    "../server/src/shared/database/database.client.js"
  );
  const { env, assertServerConfig } = await import("../server/src/shared/config/env.js");
  assertServerConfig();
  if (env.databaseDriver === "none")
    throw new Error("Configure DATABASE_DRIVER=mongodb or postgres and DATABASE_URL in .env");
  try {
    await connectDatabase();
    if (command === "internal") await internal(rest[0], rest[1]);
    else if (command === "logs") await logs(rest[0]);
    else
      await withLock(async () => {
        if (command === "liquidity") await liquidity(rest);
        else if (command === "stop") await stop();
        else if (command === "deploy") await deploy();
        else {
          if (command === "restart") await stop();
          await start();
        }
      });
  } finally {
    await closeDatabase();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === entry) {
  process.umask(0o077);
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : "Management operation failed";
    console.error(
      message.replace(/(?:mongodb(?:\+srv)?|postgres(?:ql)?):\/\/\S+/g, "[database URL redacted]"),
    );
    process.exitCode = 1;
  });
}
