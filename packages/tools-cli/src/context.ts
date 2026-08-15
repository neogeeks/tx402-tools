/**
 * What a command is given.
 *
 * Every I/O the CLI performs is a parameter here rather than a global reach:
 * argv, stdout, stderr, stdin, the environment and `fetch`. That is not
 * ceremony — it is what lets `test/cli.test.ts` drive the real command entry
 * point with an argv array and captured output, and what lets the zero-network
 * test assert that a command made no call rather than that a mock was not hit.
 */

import type { Connector, Resolver } from "../../../worker/lib/guard.js";
import type { ParsedArgs } from "./args.js";

export interface CommandContext {
  args: ParsedArgs;
  print(line: string): void;
  printErr(line: string): void;
  /** Read the whole of stdin. Only called for `-` and for `replay` with no file. */
  readStdin(): Promise<string>;
  env: Record<string, string | undefined>;
  /**
   * Injected by the tests. Undefined in production, where the commands that
   * are allowed to call out use the platform `fetch`, and the ones that are
   * not never reach this field.
   */
  fetchImpl?: typeof fetch;
  /**
   * The guard's two transport ports, injected by the tests so `inspect` can be
   * driven against a scripted DNS answer and a scripted hostile response
   * without touching the network (`test/net-stubs.ts`).
   *
   * Programmatic only. There is deliberately **no flag** that reaches this:
   * a CLI whose transport could be swapped from argv would be a way to make
   * the guard validate one thing and connect to another.
   */
  probeOverrides?: { connector?: Connector; resolver?: Resolver };
}

export interface CommandResult {
  exitCode: number;
}
