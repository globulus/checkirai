import { join } from "node:path";
import { type Db, migrate, openDb } from "../persistence/db.js";
import { RunEventBus } from "./eventBus.js";

export type OpsContext = {
  outRoot: string;
  db: Db;
  events: RunEventBus;
};

export function createOpsContext(opts?: {
  outRoot?: string;
  events?: RunEventBus;
}): OpsContext {
  const outRoot = opts?.outRoot ?? ".verifier";
  const dbPath = join(outRoot, "verifier.sqlite");
  const db = openDb(dbPath);
  migrate(db);
  return {
    outRoot,
    db,
    events: opts?.events ?? new RunEventBus(),
  };
}
