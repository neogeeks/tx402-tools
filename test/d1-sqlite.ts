/**
 * A D1 API over real SQLite, for the crawler tests.
 *
 * ── Why this and not a second vitest project ──────────────────────────────
 *
 * anticipated that would add a `@cloudflare/vitest-pool-workers`
 * project for real D1, and noted it had not needed one yet. It
 * turns out does not need one either, and the reason is worth stating: what
 * the data-plane tests have to exercise is **SQL**, not workerd.
 *
 * The properties under test are the append-only TRIGGERS in
 * `migrations/0001_init.sql`, the CHECK constraints that hold the write policy,
 * the UNIQUE constraints that make dedupe real, and the upsert semantics of
 * `ON CONFLICT`. All of those are SQLite behaviour, D1 *is* SQLite, and Node 22
 * ships a real SQLite in `node:sqlite`. So the migrations run verbatim —
 * including both triggers — and a test that tries to UPDATE `term_changes`
 * fails for exactly the reason it would fail in production.
 *
 * This also keeps the suite in one vitest project, which means it does not need
 * the CSS `resolve.alias` that `vitest.config.ts` documents, and does not touch
 * a config file does not own.
 *
 * The adapter implements only the D1 surface the crawler actually uses. It is a
 * test double for the *API shape*, over a real database — not a fake database.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

type Row = Record<string, unknown>;

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, args);
  }

  private normalized(): SQLInputValue[] {
    // SQLite binds null, number, bigint, string and Uint8Array. Booleans and
    // undefined arrive from the crawler's own types and must be coerced the way
    // D1 coerces them, or a test passes for the wrong reason.
    return this.args.map((arg): SQLInputValue => {
      if (arg === undefined || arg === null) return null;
      if (typeof arg === "boolean") return arg ? 1 : 0;
      if (typeof arg === "number" || typeof arg === "bigint" || typeof arg === "string") {
        return arg;
      }
      if (arg instanceof Uint8Array) return arg;
      // Anything else would be stringified to "[object Object]" by SQLite's
      // coercion. Failing loudly here beats storing that as though it were data.
      throw new TypeError(`cannot bind ${typeof arg} to a SQL parameter`);
    });
  }

  first<T = Row>(): Promise<T | null> {
    const statement = this.db.prepare(this.sql);
    const row = statement.get(...this.normalized());
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T = Row>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const statement = this.db.prepare(this.sql);
    const rows = statement.all(...this.normalized());
    return Promise.resolve({
      results: rows as T[],
      success: true,
      meta: { changes: 0 },
    });
  }

  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const statement = this.db.prepare(this.sql);
    const result = statement.run(...this.normalized());
    return Promise.resolve({
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    });
  }

  /**
   * Part of the D1 surface, and deliberately not implemented.
   *
   * Present so the class structurally satisfies `D1PreparedStatement` without a
   * double cast — and throwing rather than guessing, because nothing in the
   * crawler uses the raw column-array form, and a silent wrong answer from a
   * test double is worse than a missing one.
   */
  raw(): never {
    throw new Error("raw() is not implemented in the test adapter");
  }

  /** `db.batch` needs to run a statement and report both rows and changes. */
  execute(): { results: Row[]; meta: { changes: number } } {
    const statement = this.db.prepare(this.sql);
    const args = this.normalized();

    // `.run` on a SELECT returns no rows, and `.all` on an INSERT reports no
    // changes, so the statement kind decides which one answers.
    if (/^\s*(select|with|pragma)/iu.test(this.sql)) {
      return { results: statement.all(...args), meta: { changes: 0 } };
    }

    const result = statement.run(...args);
    return { results: [], meta: { changes: Number(result.changes ?? 0) } };
  }
}

/**
 * Present the adapter as a `D1PreparedStatement`.
 *
 * A standalone function rather than a cast at the call site: D1's `meta` object
 * carries five fields about the real engine (`duration`, `size_after`,
 * `rows_read`, `rows_written`, `changed_db`) that an in-memory SQLite cannot
 * honestly report, and inventing values for them would put fabricated numbers
 * where a test might one day read them. So the shim is narrowed once, here,
 * where the reason can be written down.
 */
function asD1(statement: SqliteStatement): D1PreparedStatement {
  return statement as unknown as D1PreparedStatement;
}

export interface TestDatabase {
  db: D1Database;
  /** The underlying handle, for assertions the D1 API cannot express. */
  raw: DatabaseSync;
  close(): void;
}

/**
 * A fresh in-memory database with every migration applied.
 *
 * Applied by splitting on `;` at statement boundaries — with the CREATE TRIGGER
 * bodies handled explicitly, because a trigger contains a `;` inside BEGIN…END
 * and a naive split would cut it in half and silently drop the append-only
 * enforcement. Losing exactly that would make the most important test in this
 * session pass for the wrong reason.
 */
export function createTestDb(): TestDatabase {
  const sqlite = new DatabaseSync(":memory:");

  // we appended 0004. This list is the one place a new migration has to be
  // named for the crawler and claim tests to run against the real schema;
  // forgetting it is how a test passes against a table shape production does
  // not have.
  for (const file of [
    "0001_init.sql",
    "0002_crawler.sql",
    "0003_drop_accounts.sql",
    "0004_claims_no_people.sql",
  ]) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of splitStatements(sql)) {
      sqlite.exec(statement);
    }
  }

  const d1: D1Database = {
    prepare(sql: string) {
      return asD1(new SqliteStatement(sqlite, sql));
    },
    async batch<T = Row>(statements: D1PreparedStatement[]) {
      const out = [];
      for (const statement of statements) {
        const result = (statement as unknown as SqliteStatement).execute();
        out.push({
          results: result.results as T[],
          success: true as const,
          meta: result.meta,
        });
      }
      return out as never;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump() {
      throw new Error("dump() is not implemented in the test adapter");
    },
    withSession() {
      throw new Error("withSession() is not implemented in the test adapter");
    },
  };

  return {
    db: d1,
    raw: sqlite,
    close: () => sqlite.close(),
  };
}

/**
 * Split a migration into statements, keeping `CREATE TRIGGER … BEGIN … END;`
 * whole.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;

  for (const line of sql.split("\n")) {
    const withoutComment = line.replace(/--.*$/u, "");
    if (withoutComment.trim().length === 0 && current.trim().length === 0) continue;

    current += line + "\n";

    if (/create\s+trigger/iu.test(withoutComment)) inTrigger = true;

    if (inTrigger) {
      // Only `END;` closes a trigger body.
      if (/^\s*end\s*;/iu.test(withoutComment)) {
        statements.push(current);
        current = "";
        inTrigger = false;
      }
      continue;
    }

    if (withoutComment.includes(";")) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
    }
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);

  return statements.filter((s) => s.replace(/--.*$/gmu, "").trim().length > 0);
}
