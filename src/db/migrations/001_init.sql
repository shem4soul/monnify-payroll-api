CREATE SEQUENCE IF NOT EXISTS employee_code_seq START 1;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN', 'PAYROLL_MANAGER', 'VIEWER')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code  TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  salary_kobo    BIGINT NOT NULL CHECK (salary_kobo > 0),
  bank_code      TEXT NOT NULL,
  bank_name      TEXT,
  account_number TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employees_active ON employees (is_active);

CREATE TABLE payrolls (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period                  TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                            ('DRAFT', 'QUEUED', 'AWAITING_AUTHORIZATION', 'PROCESSING',
                             'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED')),
  employee_count          INTEGER NOT NULL,
  total_kobo              BIGINT NOT NULL,
  current_batch_reference TEXT,
  created_by              UUID REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live payroll per period: stops an accidental second run from paying everyone twice.
CREATE UNIQUE INDEX uq_payroll_period_live ON payrolls (period) WHERE status <> 'FAILED';

CREATE TABLE payroll_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_id         UUID NOT NULL REFERENCES payrolls (id) ON DELETE CASCADE,
  employee_id        UUID NOT NULL REFERENCES employees (id),
  amount_kobo        BIGINT NOT NULL CHECK (amount_kobo > 0),
  status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN
                       ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  attempt            INTEGER NOT NULL DEFAULT 1,
  payment_reference  TEXT NOT NULL UNIQUE,
  batch_reference    TEXT,
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_id, employee_id)
);
CREATE INDEX idx_items_payroll_status ON payroll_items (payroll_id, status);

-- Every webhook body we have applied. A repeat delivery hits the primary key and is ignored.
CREATE TABLE webhook_events (
  event_key   TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
