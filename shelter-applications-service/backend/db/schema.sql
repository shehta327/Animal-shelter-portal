-- Adoption Applications service: Neon Postgres schema (run with: npm run migrate)
-- This service owns these tables; no other service reads them directly.
CREATE TABLE IF NOT EXISTS applications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id          UUID NOT NULL,                                  -- id from the Animals service
  animal_name        TEXT NOT NULL,                                  -- copied at submit time for display
  adopter_id         TEXT NOT NULL,                                  -- Cognito "sub"
  adopter_name       TEXT NOT NULL,
  adopter_email      TEXT NOT NULL,                                  -- for status emails only
  housing_type       TEXT NOT NULL CHECK (housing_type IN ('apartment','house','house_with_garden','other')),
  has_other_pets     BOOLEAN NOT NULL,
  has_children       BOOLEAN NOT NULL DEFAULT FALSE,
  experience         TEXT NOT NULL DEFAULT '' CHECK (char_length(experience) <= 1000),
  message            TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 1000),
  status             TEXT NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted','under_review','approved','rejected','withdrawn','completed')),
  visit_completed_at TIMESTAMPTZ,                                    -- set by the VisitCompleted event
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One ACTIVE application per adopter per animal -> 409 DUPLICATE_APPLICATION
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_active_idx
  ON applications (adopter_id, animal_id) WHERE status IN ('submitted','under_review','approved');
-- At most ONE approved application per animal -> 409 ANIMAL_ALREADY_APPROVED
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_approved_idx
  ON applications (animal_id) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS applications_adopter_idx ON applications (adopter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status, created_at DESC);

-- Full audit trail of every change (status, notes, visit results)
CREATE TABLE IF NOT EXISTS application_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL CHECK (kind IN ('status','note','visit')),
  from_status    TEXT,
  to_status      TEXT,
  actor_id       TEXT NOT NULL,                                      -- Cognito sub, or 'system'
  actor_role     TEXT NOT NULL,
  note           TEXT CHECK (char_length(note) <= 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS application_events_app_idx ON application_events (application_id, created_at);
