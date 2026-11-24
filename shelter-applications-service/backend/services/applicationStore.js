// Model: applications in Neon Postgres. Every status change and its audit
// event are written in ONE SQL statement (data-modifying CTE), so they commit
// together or not at all.
const { db } = require('../db');

const COLUMNS = `id, animal_id AS "animalId", animal_name AS "animalName", adopter_id AS "adopterId",
  adopter_name AS "adopterName", housing_type AS "housingType", has_other_pets AS "hasOtherPets",
  has_children AS "hasChildren", experience, message, status, visit_completed_at AS "visitCompletedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(a, actor) {
  const sql = await db();
  const rows = await sql.query(`
    WITH app AS (
      INSERT INTO applications (animal_id, animal_name, adopter_id, adopter_name, adopter_email,
        housing_type, has_other_pets, has_children, experience, message)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *),
    ev AS (
      INSERT INTO application_events (application_id, kind, from_status, to_status, actor_id, actor_role)
      SELECT id, 'status', NULL, 'submitted', $3, $11 FROM app)
    SELECT ${COLUMNS} FROM app`,
  [a.animalId, a.animalName, actor.sub, a.adopterName, actor.email, a.housingType, a.hasOtherPets,
    a.hasChildren, a.experience, a.message, actor.role]);
  return rows[0];
}

async function countActive(adopterId) {
  const sql = await db();
  const rows = await sql`SELECT count(*)::int AS n FROM applications
    WHERE adopter_id = ${adopterId} AND status IN ('submitted','under_review','approved')`;
  return rows[0].n;
}

// staff: everything; adopter: own rows only (ownership enforced in SQL)
async function list({ adopterId, status, animalId }) {
  const sql = await db();
  return sql.query(`SELECT ${COLUMNS} FROM applications
    WHERE ($1::text IS NULL OR adopter_id = $1)
      AND ($2::text IS NULL OR status = $2)
      AND ($3::uuid IS NULL OR animal_id = $3)
    ORDER BY created_at DESC LIMIT 200`, [adopterId || null, status || null, animalId || null]);
}

async function get(id, { adopterId } = {}) {
  const sql = await db();
  const rows = await sql.query(`SELECT ${COLUMNS}, adopter_email AS "adopterEmail" FROM applications
    WHERE id = $1 AND ($2::text IS NULL OR adopter_id = $2)`, [id, adopterId || null]);
  return rows[0] || null;
}

async function history(id) {
  const sql = await db();
  return sql`SELECT kind, from_status AS "fromStatus", to_status AS "toStatus", actor_role AS "actorRole",
      note, created_at AS "at"
    FROM application_events WHERE application_id = ${id} ORDER BY created_at, id`;
}

async function activeFor(adopterId, animalId) {
  const sql = await db();
  const rows = await sql`SELECT id, status, visit_completed_at AS "visitCompletedAt" FROM applications
    WHERE adopter_id = ${adopterId} AND animal_id = ${animalId}
      AND status IN ('submitted','under_review','approved') LIMIT 1`;
  return rows[0] || null;
}

// Moves one application from -> to. For 'approved' a completed visit is required.
// For 'completed' every other open application for the same animal is rejected
// in the same statement. Returns { changed, autoRejected[] } (changed = null if
// the application was no longer in `from`).
async function transition(app, to, actor, note) {
  const sql = await db();
  const needsVisit = to === 'approved';
  const closeOthers = to === 'completed';
  const [row] = await sql.query(`
    WITH changed AS (
      UPDATE applications SET status = $2, updated_at = now()
      WHERE id = $1 AND status = $3 AND (NOT $6 OR visit_completed_at IS NOT NULL)
      RETURNING id, animal_id, animal_name, adopter_id, adopter_name, adopter_email, status),
    others AS (
      UPDATE applications SET status = 'rejected', updated_at = now()
      WHERE $7 AND animal_id = (SELECT animal_id FROM changed) AND id <> $1
        AND status IN ('submitted','under_review')
      RETURNING id, adopter_name, adopter_email, animal_name),
    ev AS (
      INSERT INTO application_events (application_id, kind, from_status, to_status, actor_id, actor_role, note)
      SELECT id, 'status', $3, $2, $4, $5, $8 FROM changed
      UNION ALL
      SELECT id, 'status', NULL, 'rejected', 'system', 'system', 'Animal adopted by another applicant' FROM others)
    SELECT (SELECT row_to_json(c) FROM changed c) AS changed,
           COALESCE((SELECT json_agg(o) FROM others o), '[]'::json) AS "autoRejected"`,
  [app.id, to, app.status, actor.sub, actor.role, needsVisit, closeOthers, note || null]);
  return row;
}

async function addNote(id, actor, note) {
  const sql = await db();
  const rows = await sql`
    INSERT INTO application_events (application_id, kind, actor_id, actor_role, note)
    SELECT id, 'note', ${actor.sub}, ${actor.role}, ${note} FROM applications WHERE id = ${id}
    RETURNING id, kind, note, created_at AS "at"`;
  return rows[0] || null;
}

// From the Visits service: a completed visit unlocks approval and moves a
// submitted application into review automatically. Idempotent.
async function recordVisit(applicationId, outcome, note) {
  const sql = await db();
  const completed = outcome === 'completed';
  const auditNote = `Visit ${completed ? 'completed' : 'missed (no show)'}${note ? `: ${note}` : ''}`.slice(0, 500);
  const [row] = await sql.query(`
    WITH app AS (
      UPDATE applications SET
        visit_completed_at = CASE WHEN $2 THEN COALESCE(visit_completed_at, now()) ELSE visit_completed_at END,
        status = CASE WHEN $2 AND status = 'submitted' THEN 'under_review' ELSE status END,
        updated_at = now()
      WHERE id = $1 AND status IN ('submitted','under_review','approved')
      RETURNING id, status, adopter_name, adopter_email, animal_name,
        (SELECT status FROM applications WHERE id = $1) AS old_status),
    ev AS (
      INSERT INTO application_events (application_id, kind, from_status, to_status, actor_id, actor_role, note)
      SELECT id, 'visit', NULL, NULL, 'system', 'system', $3 FROM app
      UNION ALL
      SELECT id, 'status', old_status, status, 'system', 'system', 'Moved to review after a completed visit'
      FROM app WHERE old_status <> status)
    SELECT row_to_json(app) AS app FROM app`,
  [applicationId, completed, auditNote]);
  return row ? row.app : null;
}

module.exports = { create, countActive, list, get, history, activeFor, transition, addNote, recordVisit };
