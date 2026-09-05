import type pg from "pg";
import { SelfTestService as SharedSelfTestService } from "@mathpilot/self-test";
import { resolveLearningSubject } from "../learning-read/acl.ts";
export * from "@mathpilot/self-test";

export class SelfTestService extends SharedSelfTestService {
  constructor(pool: pg.Pool) { super(pool, resolveLearningSubject); }
}
