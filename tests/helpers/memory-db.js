// Minimal in-memory stand-in for the Cloudflare D1 prepared-statement API.
// It does NOT implement general SQL; it pattern-matches only the specific
// statements that room-service.js issues, which keeps the tests honest about
// the real query surface without pulling in a SQLite dependency.

export function createMemoryDb() {
  const rooms = new Map();
  const participants = new Map();

  function prepare(sql) {
    const text = sql.replace(/\s+/g, " ").trim();
    return new Statement(text, { rooms, participants });
  }

  return { prepare, _rooms: rooms, _participants: participants };
}

class Statement {
  constructor(sql, tables) {
    this.sql = sql;
    this.tables = tables;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    return this._exec();
  }

  async first() {
    const rows = this._select();
    return rows.length ? rows[0] : null;
  }

  async all() {
    return { results: this._select() };
  }

  _exec() {
    const { rooms, participants } = this.tables;
    const sql = this.sql;
    const p = this.params;

    if (sql.startsWith("INSERT INTO rooms")) {
      const [id, host_participant_id, host_token_hash, created_at, updated_at] = p;
      rooms.set(id, { id, host_participant_id, host_token_hash, created_at, updated_at });
      return { success: true };
    }

    if (sql.startsWith("INSERT INTO participants")) {
      // VALUES (?, ?, ?, 'host'|'participant', '{}', ?, ?)
      const role = sql.includes("'host'") ? "host" : "participant";
      const [id, room_id, display_name, created_at, updated_at] = p;
      participants.set(id, {
        id,
        room_id,
        display_name,
        role,
        state_json: "{}",
        created_at,
        updated_at
      });
      return { success: true };
    }

    if (sql.startsWith("UPDATE participants SET state_json")) {
      const [state_json, updated_at, id, room_id] = p;
      const row = participants.get(id);
      if (row && row.room_id === room_id) {
        row.state_json = state_json;
        row.updated_at = updated_at;
      }
      return { success: true };
    }

    if (sql.startsWith("DELETE FROM participants WHERE id = ? AND room_id = ?")) {
      const [id, room_id] = p;
      const row = participants.get(id);
      if (row && row.room_id === room_id) participants.delete(id);
      return { success: true };
    }

    if (sql.startsWith("UPDATE rooms SET updated_at")) {
      const [updated_at, id] = p;
      const row = rooms.get(id);
      if (row) row.updated_at = updated_at;
      return { success: true };
    }

    throw new Error(`memory-db: unsupported exec statement: ${sql}`);
  }

  _select() {
    const { rooms, participants } = this.tables;
    const sql = this.sql;
    const p = this.params;

    if (sql.startsWith("SELECT * FROM rooms WHERE id = ?")) {
      const row = rooms.get(p[0]);
      return row ? [{ ...row }] : [];
    }

    if (sql.startsWith("SELECT * FROM participants WHERE room_id = ? AND id = ?")) {
      const [room_id, id] = p;
      const row = participants.get(id);
      return row && row.room_id === room_id ? [{ ...row }] : [];
    }

    if (sql.startsWith("SELECT id, display_name, role, state_json, updated_at FROM participants WHERE room_id = ?")) {
      const room_id = p[0];
      const rows = [...participants.values()].filter((r) => r.room_id === room_id);
      // ORDER BY role = 'host' DESC, updated_at DESC
      rows.sort((a, b) => {
        const hostA = a.role === "host" ? 1 : 0;
        const hostB = b.role === "host" ? 1 : 0;
        if (hostA !== hostB) return hostB - hostA;
        return b.updated_at.localeCompare(a.updated_at);
      });
      return rows.map((r) => ({
        id: r.id,
        display_name: r.display_name,
        role: r.role,
        state_json: r.state_json,
        updated_at: r.updated_at
      }));
    }

    throw new Error(`memory-db: unsupported select statement: ${sql}`);
  }
}
