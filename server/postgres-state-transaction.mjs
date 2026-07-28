const STATE_ROW_ID = "local-state";

function assertTableName(table) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(table || ""))) {
    throw new Error("状态表名不合法");
  }
}

export async function persistPostgresStateAtomically({
  client,
  table,
  state,
  protectedState,
  mirror,
}) {
  assertTableName(table);
  if (!client?.query) throw new Error("缺少 PostgreSQL 事务客户端");
  if (typeof mirror !== "function") throw new Error("缺少正式表镜像函数");

  const currentVersion = Number(state?.__storageVersion || 0);
  let nextVersion = currentVersion + 1;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["sonli-local-state"]);
    if (currentVersion > 0) {
      const result = await client.query(
        `
          UPDATE ${table}
          SET state = $1::jsonb, version = version + 1, updated_at = NOW()
          WHERE id = $2 AND version = $3
          RETURNING version
        `,
        [JSON.stringify(protectedState), STATE_ROW_ID, currentVersion],
      );
      if (!result.rowCount) {
        const error = new Error("本地状态已被其他操作更新，请刷新后重试");
        error.code = "LOCAL_STATE_VERSION_CONFLICT";
        error.status = 409;
        throw error;
      }
      nextVersion = Number(result.rows[0]?.version || nextVersion);
    } else {
      const result = await client.query(
        `
          INSERT INTO ${table} (id, state, version, updated_at)
          VALUES ($1, $2::jsonb, 1, NOW())
          ON CONFLICT (id)
          DO UPDATE SET state = EXCLUDED.state, version = ${table}.version + 1, updated_at = NOW()
          RETURNING version
        `,
        [STATE_ROW_ID, JSON.stringify(protectedState)],
      );
      nextVersion = Number(result.rows[0]?.version || 1);
    }

    await mirror(client, state);
    await client.query("COMMIT");
    Object.defineProperty(state, "__storageVersion", {
      value: nextVersion,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return { version: nextVersion };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  }
}
