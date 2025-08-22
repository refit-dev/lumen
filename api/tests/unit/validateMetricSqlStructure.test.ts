import { describe, it, expect } from "bun:test";
import { validateMetricSqlStructure } from "../../src/routes/metrics";

describe("validateMetricSqlStructure", () => {
  it("should return invalid for empty SQL", () => {
    const result = validateMetricSqlStructure("");
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("SQL definition cannot be empty.");
  });

  it("should return invalid for non-select statements", () => {
    const result1 = validateMetricSqlStructure(
      "UPDATE filtered_events SET id = 1"
    );
    expect(result1.isValid).toBe(false);
    expect(result1.error).toBe("SQL must be a single SELECT statement.");

    const result2 = validateMetricSqlStructure("DELETE FROM filtered_events");
    expect(result2.isValid).toBe(false);
    expect(result2.error).toBe("SQL must be a single SELECT statement.");
  });

  it("should return invalid for multiple statements", () => {
    const sql = "SELECT * FROM filtered_events; SELECT * FROM filtered_events";
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("SQL must be a single SELECT statement.");
  });

  it("should allow simple SELECT without FROM", () => {
    const result = validateMetricSqlStructure("SELECT 1 + 2");
    expect(result.isValid).toBe(true);
  });

  it("should allow SELECT from filtered_events", () => {
    const result = validateMetricSqlStructure("SELECT * FROM filtered_events");
    expect(result.isValid).toBe(true);
  });

  it("should reject SELECT from other tables", () => {
    const result = validateMetricSqlStructure("SELECT * FROM users");
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Invalid table reference: users/);
  });

  it("should allow joins on filtered_events only", () => {
    const sql =
      "SELECT fe.id FROM filtered_events fe JOIN filtered_events fe2 ON fe.id = fe2.id";
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
  });

  it("should reject joins against other tables", () => {
    const sql =
      "SELECT fe.id FROM filtered_events fe JOIN orders o ON fe.id = o.id";
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(
      /Invalid table reference.*: orders. Only 'filtered_events' or valid CTEs allowed./
    );
  });

  it("should allow subqueries only on filtered_events", () => {
    const sql = "SELECT * FROM (SELECT * FROM filtered_events) sub";
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
  });

  it("should reject subqueries referencing other tables", () => {
    const sql = "SELECT * FROM (SELECT * FROM products) p";
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Invalid table reference: products/);
  });

  it("should allow allowed functions regardless of case", () => {
    const funcs = [
      "count",
      "SUM",
      "Avg",
      "min",
      "MAX",
      "uPpEr",
      "lower",
      "LeNgTh",
    ];
    funcs.forEach((fn) => {
      const sql = `SELECT ${fn}(event_id) FROM filtered_events`;
      const res = validateMetricSqlStructure(sql);
      expect(res.isValid).toBe(true);
    });
  });

  it("should allow newly allowed functions", () => {
    const allowedNewFuncs = ["coalesce", "date_trunc", "extract"];
    allowedNewFuncs.forEach((fn) => {
      let sql;
      if (fn === "coalesce") {
        sql = `SELECT ${fn}(col1, 'default') FROM filtered_events`;
      } else if (fn === "date_trunc") {
        sql = `SELECT ${fn}('day', timestamp_col) FROM filtered_events`;
      } else if (fn === "extract") {
        sql = `SELECT ${fn}(HOUR FROM timestamp_col) FROM filtered_events`;
      } else {
        sql = `SELECT ${fn}(some_col) FROM filtered_events`;
      }
      const res = validateMetricSqlStructure(sql);
      expect(res.isValid).toBe(true);
      expect(res.error).toBeUndefined();
    });
  });

  it("should reject functions not explicitly allowed", () => {
    const result = validateMetricSqlStructure(
      "SELECT now() FROM filtered_events"
    );
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Disallowed function call: now/);
  });

  it("should allow arithmetic expressions", () => {
    const sql = "SELECT SUM(amount) + MAX(amount) - 5 FROM filtered_events";
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
  });

  // *** START: Added Complex Test Cases ***

  it("should allow complex valid query with subquery, join, and functions", () => {
    const sql = `
      SELECT
        sub.event_type,
        COUNT(fe1.id) AS event_count,
        MAX(sub.timestamp) AS last_event_time,
        UPPER(COALESCE(fe1.properties ->> 'detail', 'N/A')) AS upper_detail
      FROM (
        SELECT * FROM filtered_events WHERE timestamp > date_trunc('day', '2023-01-01T00:00:00Z')
      ) AS sub
      JOIN filtered_events fe1 ON sub.id = fe1.correlation_id
      WHERE fe1.event_name = 'processed'
      GROUP BY sub.event_type
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should reject complex query with disallowed table in subquery", () => {
    const sql = `
      SELECT
        sub.product_name,
        COUNT(fe1.id) AS event_count
      FROM (
        SELECT * FROM products WHERE created_at > '2023-01-01'
      ) AS sub
      JOIN filtered_events fe1 ON sub.id = fe1.product_ref
      GROUP BY sub.product_name
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Invalid table reference: products/);
  });

  it("should reject complex query with disallowed table in join", () => {
    const sql = `
      SELECT
        fe.id,
        COUNT(u.id) AS user_actions
      FROM filtered_events fe
      JOIN users u ON fe.user_id = u.id
      WHERE fe.timestamp > date_trunc('day', '2023-01-01T00:00:00Z')
      GROUP BY fe.id
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    // The error check needs to be specific about which table reference failed.
    // It could be the direct JOIN reference or potentially something inside the ON clause if complex.
    expect(result.error).toMatch(/Invalid table reference( in JOIN)?: users/);
  });

  it("should reject complex query with disallowed function", () => {
    const sql = `
      SELECT
        fe.event_type,
        COUNT(*) AS count,
        generate_series(1, 5) AS series_num -- Disallowed function
      FROM filtered_events fe
      WHERE fe.timestamp > date_trunc('day', '2023-01-01T00:00:00Z')
      GROUP BY fe.event_type
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Disallowed function call: generate_series/);
  });

  it("should allow nested allowed functions", () => {
    const sql = `SELECT UPPER(COALESCE(properties ->> 'name', 'UNKNOWN')) FROM filtered_events`;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should allow allowed function in WHERE clause", () => {
    const sql = `SELECT id FROM filtered_events WHERE LOWER(event_name) = 'completed'`;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should reject disallowed function in WHERE clause", () => {
    const sql = `SELECT id FROM filtered_events WHERE pg_sleep(1) IS NULL`; // Disallowed function
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Disallowed function call: pg_sleep/);
  });

  // *** END: Added Complex Test Cases ***

  // *** START: Added CTE and Nested Subquery Test Cases ***

  it("should allow valid query with CTE based on filtered_events", () => {
    const sql = `
      WITH UserEvents AS (
        SELECT
          user_id,
          COUNT(*) AS event_count,
          MAX(timestamp) as last_event_ts
        FROM filtered_events
        WHERE event_name = 'login'
        GROUP BY user_id
      )
      SELECT user_id, event_count
      FROM UserEvents
      WHERE event_count > 1
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should reject query with CTE selecting from disallowed table", () => {
    const sql = `
      WITH UserDetails AS (
        SELECT id, name FROM users WHERE signup_date > '2023-01-01' -- disallowed table
      )
      SELECT ud.name, COUNT(fe.id)
      FROM UserDetails ud
      JOIN filtered_events fe ON ud.id = fe.user_id
      GROUP BY ud.name
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    // The parser might catch the table reference within the CTE definition
    expect(result.error).toMatch(/Invalid table reference.*: users/);
  });

  it("should reject query with CTE using disallowed function", () => {
    const sql = `
      WITH EventSeries AS (
        SELECT generate_series(1, 10) as num -- disallowed function
      )
      SELECT es.num, fe.id
      FROM EventSeries es
      CROSS JOIN filtered_events fe
      LIMIT 100
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Disallowed function call: generate_series/);
  });

  it("should allow valid query with nested subqueries on filtered_events", () => {
    const sql = `
      SELECT outer_sub.user_id, outer_sub.first_event_ts
      FROM (
        SELECT
          inner_sub.user_id,
          MIN(inner_sub.timestamp) as first_event_ts
        FROM (
          SELECT user_id, timestamp
          FROM filtered_events
          WHERE event_type = 'signup'
        ) AS inner_sub
        GROUP BY inner_sub.user_id
      ) AS outer_sub
      WHERE outer_sub.first_event_ts < '2024-01-01T00:00:00Z'
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should reject nested subquery with disallowed table at inner level", () => {
    const sql = `
      SELECT outer_sub.user_id, outer_sub.first_login_ts
      FROM (
        SELECT
          inner_sub.user_id,
          MIN(inner_sub.login_time) as first_login_ts
        FROM (
          SELECT user_id, login_time FROM user_logins -- disallowed table
        ) AS inner_sub
        GROUP BY inner_sub.user_id
      ) AS outer_sub
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Invalid table reference.*: user_logins/);
  });

  it("should reject nested subquery with disallowed function at inner level", () => {
    const sql = `
      SELECT outer_sub.event_type, outer_sub.random_val
      FROM (
        SELECT
          inner_sub.event_type,
          MAX(inner_sub.rnd) as random_val
        FROM (
          SELECT event_type, random() as rnd FROM filtered_events -- disallowed function
        ) AS inner_sub
        GROUP BY inner_sub.event_type
      ) AS outer_sub
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Disallowed function call: random/);
  });

  it("should allow complex valid query with CTE and join", () => {
    const sql = `
      WITH AggregatedEvents AS (
        SELECT event_name, COUNT(*) as cnt
        FROM filtered_events
        GROUP BY event_name
      )
      SELECT fe.id, fe.timestamp, ae.cnt
      FROM filtered_events fe
      JOIN AggregatedEvents ae ON fe.event_name = ae.event_name
      WHERE ae.cnt > 10
    `;
    const result = validateMetricSqlStructure(sql);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // *** END: Added CTE and Nested Subquery Test Cases ***
});
