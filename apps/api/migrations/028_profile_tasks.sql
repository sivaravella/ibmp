-- Business profile: the details of the enterprise that are not printed on invoices but belong on file.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS entity_type TEXT;       -- proprietorship, partnership, llp, private_limited, public_limited, opc, huf, trust, society, other
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cin TEXT;               -- CIN of a company or LLPIN of an LLP
ALTER TABLE companies ADD COLUMN IF NOT EXISTS udyam TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tan TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_person TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS incorporated_on DATE;

-- Task manager. The owner lists and manages tasks first; employee and consultant sign-ins can later be assigned tasks through assignee_employee_id.
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',            -- todo | inprogress | review | done
  priority TEXT NOT NULL DEFAULT 'medium',        -- low | medium | high | critical
  category TEXT,
  assignee TEXT,                                  -- a name typed by the owner, or the employee's name
  assignee_employee_id INTEGER,
  due_date DATE,
  created_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS tasks_company_status ON tasks (company_id, status);

CREATE TABLE IF NOT EXISTS task_checklist (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS task_checklist_task ON task_checklist (task_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments (task_id);
