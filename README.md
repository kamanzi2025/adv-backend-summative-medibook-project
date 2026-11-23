# MediBook: Clinic Appointment System (backend)

Node.js + Express 5 + MySQL 8 (`mysql2`, parameterized queries only, no ORM) + Redis 7 (BullMQ + plain lists).
Exactly 3 tables (`patients`, `doctors`, `appointments`), a separate background worker, an `fs` audit log,
Jest unit tests and a bilingual feedback page.

> The original assignment brief is kept unchanged **below the divider** at the end of this section.
> Detailed reasoning for every decision: [`DESIGN_NOTES.md`](DESIGN_NOTES.md). Demo order: [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md).
> Schema diagram: [`schema-diagram.png`](schema-diagram.png), rendered from [`docs/schema-diagram.html`](docs/schema-diagram.html) (also as [`docs/schema.dbml`](docs/schema.dbml) and Mermaid in [`docs/schema-diagram.md`](docs/schema-diagram.md)).

## Prerequisites

- **Node.js 18+** (developed on 22) and npm
- **MySQL 8.0** running locally (developed on the native Windows service `MySQL80`, port 3306)
- **Docker** (for Redis 7, via `docker-compose.yml`); any Redis ≥ 6.2 works (`LMOVE` is needed)
- Optional: the VS Code **REST Client** extension, to run [`requests.http`](requests.http)

## Setup

Run every command from the **project root** in **PowerShell**. Steps 3–4 use the `$mysql`
variable defined at the top of step 3, so run them in the same window. The MySQL client isn't on
PATH by default; instead of `$mysql` you can add `C:\Program Files\MySQL\MySQL Server 8.0\bin` to
PATH and type `mysql`. Every `-p` prompts for that account's password.

**1. Install dependencies**
```powershell
npm install
```
`npm audit` reports 2 moderate advisories in nodemon's dev-only dependency `minimatch`. The
production dependencies are clean (`npm audit --omit=dev` → 0 vulnerabilities), so do not run
`npm audit fix --force`.

**2. Create `.env`** from the template (`.env` is gitignored and never committed):
```powershell
Copy-Item .env.example .env
```
Edit `.env` if needed. `DB_USER=medibook_user` / `DB_PASSWORD=change_me` must match the user created
in step 3.

**3. Create the least-privilege app user** (once, **as root**). The app only needs to read and
write rows, so it gets `SELECT, INSERT, UPDATE, DELETE` on `medibook.*` and nothing else. If you
picked another password in `.env`, use it here instead of `change_me`.
```powershell
$mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
& $mysql -u root -p -e "CREATE USER IF NOT EXISTS 'medibook_user'@'localhost' IDENTIFIED BY 'change_me'; GRANT SELECT, INSERT, UPDATE, DELETE ON medibook.* TO 'medibook_user'@'localhost';"
& $mysql -u root -p -e "SHOW GRANTS FOR 'medibook_user'@'localhost';"
```
The grant can be given before the database exists, and it survives re-running `schema.sql`, because
MySQL stores grants by database *name*.

**4. Load the schema and the seed data, as root.** The app user can't load them:
`schema.sql` starts with `DROP DATABASE IF EXISTS medibook; CREATE DATABASE medibook`, which needs
root. PowerShell has no `<` redirection, so use the client's `source` command:
```powershell
& $mysql -u root -p --default-character-set=utf8mb4 -e "source database/schema.sql"
& $mysql -u root -p --default-character-set=utf8mb4 -e "source database/seed.sql"
```
Optional constraint demo (as the app user; it changes nothing because everything is rolled back):
```powershell
cmd /c "`"$mysql`" -u medibook_user -p --table --force medibook < database\verify.sql"
```
It's fed through `cmd` so `--force` keeps going after the *expected* errors; `source` would stop at
the first one.

**5. Start Redis** (Docker; bound to 127.0.0.1:6379, data kept in a named volume):
```powershell
docker compose up -d
```

**6. Start the API** (terminal 1):
```powershell
npm start            # http://localhost:3000   (npm run dev = auto-restart on changes)
```
Check: `GET http://localhost:3000/api/health` → `{"status":"ok","database":"up"}`.

**7. Start the worker** (terminal 2; a separate process for waitlist promotions and confirmation "SMS"):
```powershell
npm run worker
```

**8. Run the unit tests** (pure functions only; no MySQL or Redis needed):
```powershell
npm test
```

**Optional: concurrency demos** (with the API running):
```powershell
npm run demo:concurrency   # 20 simultaneous bookings for one slot → 1 × 201; daily-cap race → stops at 12
```

**Environment variables** (`.env`, see [`.env.example`](.env.example)): `PORT`, `CLINIC_TIMEZONE`
(Africa/Johannesburg), `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `REDIS_HOST`, `REDIS_PORT`,
`REDIS_PASSWORD` (optional), `LOG_DIR` (default `logs`).

**Times** are clinic wall-clock times (`CLINIC_TIMEZONE`), sent and returned as `"YYYY-MM-DD HH:mm"`.
"Now" always comes from Node (`clinicNow()`), never from MySQL's `NOW()`. Audit-log `timestamp`s are
UTC instants.

## Project structure

```
database/      schema.sql (3NF, 3 tables, named constraints), seed.sql, verify.sql (constraint demo)
docs/          schema-diagram.html (source of schema-diagram.png), schema.dbml (dbdiagram.io), schema-diagram.md (Mermaid)
locales/       en.json, fr.json (feedback page texts)
scripts/       concurrency demo scripts (call the running API)
src/config/    env (required DB/Redis settings), settings (optional CLINIC_TIMEZONE, LOG_DIR),
               constants (every business number + HTTP status), db pool, redis
src/models/    ALL SQL, parameterized (patients, doctors, appointments, statistics, reports, health)
src/controllers/  business logic → models; choose status codes
src/routes/    URL + method → controller (405 for unsupported methods)
src/middleware/   central error handler, 404, 405
src/validators/   pure request validation
src/utils/     pure helpers: clock, slot rules, refund, payment, AppError, waitlist keys/promotion, i18n
src/services/  audit logger (fs), BullMQ producers, waitlist service, after-commit booking events
src/workers/   worker.js (separate process) + job processors
tests/         Jest unit tests (no DB/Redis)
```

## Endpoints

All JSON responses are `{ "data": ... }` (lists add `"meta"`), and every error is
`{ "error": { "status", "message", "details"? } }`.

| Method | Path | Purpose | Success | Main errors |
|---|---|---|---|---|
| GET | `/api/health` | DB connectivity | 200 | 503 |
| GET | `/api/patients?limit=&offset=` | list patients (default 20, max 100) | 200 | 400 |
| POST | `/api/patients` | create | 201 + `Location` | 400, 409 email |
| GET | `/api/patients/:id` | read one | 200 | 400, 404 |
| PATCH | `/api/patients/:id` | partial update | 200 | 400, 404, 409 |
| DELETE | `/api/patients/:id` | delete | 204 | 404, 409 has appointments |
| GET / POST | `/api/doctors` | list / create | 200 / 201 | 400, 409 room |
| GET / PATCH / DELETE | `/api/doctors/:id` | read / update / delete | 200 / 200 / 204 | 400, 404, 409 |
| POST | `/api/appointments` | **book** | 201 + `Location`, or 202 (waitlist joined) | 400, 404, 409 (+ waitlist offer), 422, 503 |
| GET | `/api/appointments/:id` | read one | 200 | 400, 404 |
| PATCH | `/api/appointments/:id/cancel` | **cancel + refund** (no body) | 200 | 400, 404, 422 |
| GET | `/api/doctors/:id/appointments?date=YYYY-MM-DD` | a doctor's day | 200 | 400, 404 |
| GET | `/api/doctors/:id/waitlist` | Redis waitlist for a doctor | 200 | 400, 404, 503 |
| GET | `/api/doctors/:id/statistics?from=YYYY-MM-DD` | revenue, upcoming, 7-day counts, utilization | 200 | 400, 404 |
| GET | `/api/reports/doctors` | every doctor's appointments + revenue | 200 | |
| GET | `/api/reports/busy-days` | doctor-days > 80% of the cap | 200 | |
| GET | `/feedback?lang=en\|fr` | feedback form (HTML) | 200 | |

Example bodies:

```jsonc
// POST /api/patients
{ "fullName": "Nana Yeboah", "email": "nana@mail.com", "phone": "+233 24 123 4567" }
// PATCH /api/patients/13  (any subset, at least one field)
{ "phone": "0200-999-888" }
// POST /api/doctors
{ "fullName": "Dr. Abena Mensah", "specialty": "General Practice", "consultationFee": 99.5, "room": "R-21" }
// POST /api/appointments  (amountPaid optional: defaults to the fee; joinWaitlist optional)
{ "patientId": 5, "doctorId": 2, "appointmentDateTime": "2027-05-03 10:00", "amountPaid": 80 }
// 409 when the slot/day is full → resend with "joinWaitlist": true → 202 with the waitlist position
{ "error": { "status": 409, "message": "Doctor 2 is already booked at 2027-05-03 10:00",
             "waitlistAvailable": true, "waitlistType": "slot",
             "hint": "Resend the same request with \"joinWaitlist\": true to join the waitlist for this slot." } }
// PATCH /api/appointments/17/cancel → 200
{ "data": { "id": 17, "status": "CANCELLED", "refundPercent": 50, "refundAmount": 50, "hoursNotice": 35.84, "...": "..." } }
```

Every endpoint and edge case is in [`requests.http`](requests.http): double booking, 13th booking, outside
hours, 09:15, every refund tier, waitlist join and promotion, reports and the feedback page.

## Justifications (Parts C, D, E)

### Part C: API and business rules
- **REST design:** plural nouns, ids in the path, the HTTP method is the verb. `PATCH` for partial
  updates (send only the changed fields; PUT would need the whole resource). `POST /api/appointments`
  is a top-level collection because an appointment belongs equally to a patient and a doctor; a doctor's
  day, waitlist and statistics are read-only sub-resources of `/api/doctors/:id`.
- **Cancel = `PATCH /api/appointments/:id/cancel`, not `DELETE`:** the record is *kept* (refund history,
  revenue); only its state changes. The refund is never accepted from the client.
- **Status codes:** 201 + `Location` (create), 204 (delete), **400** = the request is malformed (bad JSON,
  wrong types, unknown fields, `2027-02-30`), **404** = unknown id or route, **405** = wrong method on a
  real URL, **409** = valid but conflicts with current data (slot taken, day full, duplicate email,
  deleting a doctor with appointments), **422** = well-formed but breaks a business rule (past time,
  outside 09:00–16:30, 09:15, amount above the fee, cancelling twice or after the start), **503** =
  database or Redis temporarily unavailable. One central error middleware + `AppError`; 500s hide
  internals and are logged.
- **Delete behaviour:** foreign keys are `ON DELETE RESTRICT`, so deleting a patient or doctor who has
  appointments → **409** ("appointments are kept as refund history"). No cascade, so financial history
  is never lost. The model recognises both MySQL codes for this (1451 with the constraint name, and
  1217 without it, which is what the least-privilege `medibook_user` receives), so the message is
  always the specific one.
- **Slot uniqueness:** a STORED generated column `active_slot = appt_datetime if BOOKED else NULL` with
  `UNIQUE (doctor_id, active_slot)`. Two BOOKED rows for one doctor-time are impossible, while cancelled
  rows (NULL) don't block re-booking. The same trick on `(patient_id, active_slot)` stops a patient from
  being in two places at once.
- **Concurrency:** each booking is one transaction that first locks the doctor row
  (`SELECT … FOR UPDATE`), so bookings for the same doctor run one at a time. That makes "count the day,
  then insert" race-free and enforces the **12/day cap** (which no unique index can). The UNIQUE index is
  the final guarantee against double booking. Proven by `npm run demo:concurrency` (20 simultaneous →
  exactly one 201). Deadlocks and lock timeouts get a bounded retry, then 503.
- **Refund boundaries:** > 48h → 100%; **24h to 48h inclusive** → 50% (so *exactly* 48h and *exactly* 24h
  are 50%, because the brief says "more than 48" and "less than 24"); < 24h → 0%. Computed in integer
  cents, rounded exactly like MySQL `ROUND(…, 2)`, enforced again by a CHECK constraint. Status +
  refund columns are written in **one** UPDATE inside one transaction.
- **amountPaid:** defaults to the doctor's fee; an optional discount from 0 to the fee is allowed (the
  spreadsheet's AP-002 paid 120.00 on a 150.00 fee).
- **Revenue** = `SUM(amount_paid − refund_amount)`: what the clinic actually kept. **Utilization** =
  booked ÷ (12 × 7) over the 7-day window starting at `?from` (default today). All report figures are
  computed in SQL (LEFT JOIN + COALESCE, conditional COUNT, a recursive CTE for zero days, HAVING with
  the cap and threshold as parameters).

### Part D: Audit log
`src/services/auditLogger.js` appends one JSON line per event to `logs/audit.log` with `fs/promises`
(`mkdir({ recursive: true })` once, then `appendFile`). It never uses `*Sync`, so the event loop is never
blocked. One small append per line means lines never interleave. Everything is in `try/catch`, so a
logging failure only prints a console error and **never fails the request**. The one exception is
the worker's confirmation job, whose whole purpose is the log line: it uses `logStrict`, so a failed
write fails the job and BullMQ retries it instead of marking a lost message as done. Events: `APPOINTMENT_BOOKED`,
`APPOINTMENT_CANCELLED`, `WAITLIST_JOINED`, `WAITLIST_PROMOTED`, `WAITLIST_PROMOTION_FAILED`,
`NOTIFICATION_SENT`. Lines are written only after the database COMMIT, so the log never records
something that was rolled back.

### Part E: Queues and Redis
- **BullMQ for jobs** (`slot-freed`, `send-confirmation`): retries with exponential backoff, failed jobs
  kept. **Plain Redis lists for the waitlist**: strictly FIFO (`RPUSH` to join, `LMOVE … LEFT` to promote),
  easy to inspect (`GET /api/doctors/:id/waitlist`). Keys: `waitlist:doctor:{id}:slot:{datetime}` (that
  exact slot) and `waitlist:doctor:{id}:day:{date}` (the whole day was full). A Lua script prevents
  duplicate joins atomically.
- **Separate worker process** (`npm run worker`): on a cancellation, it takes the first waiting patient
  (exact-slot list first, then the day list) and books them through the **same** booking function as
  the API (same transaction and rules), then queues their confirmation.
- **A promotion that fails never loses the patient:** `LMOVE` moves the entry atomically into a
  *processing* list, and it's removed only after the booking COMMITs. **Transient** errors (DB/Redis) →
  back to the **front** of the list and the job is retried with backoff. **Permanent** failures (patient
  deleted, already booked at that time, …) → moved to `waitlist:failed` with the reason (audited), and
  the next patient is tried. "Slot re-taken meanwhile" → back to the front (not the patient's fault). On
  start-up the worker returns anything stuck in processing lists to the front of their waitlist.
- **Redis down:** MySQL is the source of truth, so booking and cancelling still succeed (the job isn't
  queued; a warning is logged), and joining or reading the waitlist → 503. A slot-freed job lost while
  Redis was down is recovered by the worker's **waitlist sweep**, which runs at start-up and then every
  60 s (`WAITLIST_SWEEP_INTERVAL_MS`): any waiting list whose slot or day has room gets a new job, so
  no restart is needed.

---
---

# Final Assessment — Backend Development

**Weight:** 30% of final grade
**Duration:** 2 weeks
**Mode:** Individual project
**Stack (mandatory):** Node.js, Express.js, MySQL (with parameterized queries only), Redis

---

## Scenario — "MediBook" Clinic Appointment System

A community clinic wants a backend service for booking doctor appointments. Doctors see patients in fixed 30-minute slots during working hours (09:00–17:00), each doctor can handle at most **12 appointments per day**, and the clinic administrator needs reports. You will design the database, build the API, and handle the operational concerns (background jobs, logging, testing).

**Entity limit:** Your database must contain **exactly 3 entities**:

| Entity | Purpose |
|---|---|
| `patients` | People who book appointments |
| `doctors` | Doctors with a specialty, consultation fee, and room |
| `appointments` | A patient's booking with a doctor at a specific date/time (links the other two) |

You may add columns as needed, but no additional tables (lookup/locale JSON files don't count).

---

## Part A — Database Design & Normalization

The clinic currently tracks everything in this single spreadsheet:

| appt_ref | patient_name | patient_email | patient_phone | doctor_name | specialty | consultation_fee | room | appt_datetime | amount_paid | booked_on |
|---|---|---|---|---|---|---|---|---|---|---|
| AP-001 | Ama Mensah | ama@mail.com | 0244-111-222 | Dr. Boateng | Dermatology | 150.00 | R-12 | 2026-08-10 09:00 | 150.00 | 2026-07-01 |
| AP-002 | Kojo Owusu | kojo@mail.com | 0555-333-444 | Dr. Boateng | Dermatology | 150.00 | R-12 | 2026-08-10 09:30 | 120.00 | 2026-07-02 |
| AP-003 | Ama Mensah | ama@mail.com | 0244-111-222 | Dr. Adjei | Paediatrics | 100.00 | R-03 | 2026-08-15 10:00 | 100.00 | 2026-07-03 |

Study the spreadsheet, then produce a **database schema diagram** of your design in fully normalized form (up to 3NF). The diagram must show **everything**:

- all 3 entities with every column and its MySQL data type,
- primary keys and foreign keys, clearly marked,
- the relationships between the entities and their cardinality (1:N, etc.),
- every constraint that enforces a business rule (`NOT NULL`, `UNIQUE`, `CHECK`) — in particular, it must be visible from the diagram that *a doctor cannot have two appointments at the same date/time*.

Use any tool you like (dbdiagram.io, draw.io) and include it in your repository as `schema-diagram` (image or PDF).

## Part B — Database Implementation & Project Setup

1. **Table creation.** Translate your Part A diagram into a MySQL DDL script, `database/schema.sql`, that creates the database and the 3 tables — data types, primary keys, foreign keys, and every constraint shown on the diagram. The script must run cleanly on a fresh MySQL server. Also provide `database/seed.sql` with realistic sample data: at least 3 patients, 3 doctors (including one with no appointments), and 8 appointments (including one doctor-day at or near the 12-slot daily cap).

2. **Project structure.** Set up the Express project in a **models / controllers / routes** structure:

```
├── database/          schema.sql and seed.sql (Part B.1)
└── src/
    ├── models/        all application SQL lives here — nowhere else
    ├── controllers/   business logic; calls model functions, never the DB directly
    └── routes/        maps URLs and HTTP methods to controllers
```

Every SQL statement in the application must use **parameterized queries** (`?` placeholders via `mysql2`). SQL found in a controller or route file loses marks. **Do not use any ORM for this assignment.**

## Part C — Controllers & Endpoints

Implement endpoints for the operations below. **Designing the API is part of the assessment**: you choose the URL paths, the HTTP methods, and how the endpoints are grouped into controllers and routes — your choices should follow REST conventions and will be marked. The business rules listed are **requirements** — *how* you satisfy them is your design decision, and you will be asked to defend it at the viva.

1. **Basic CRUD** — standard **C**reate, **R**ead (one and all), **U**pdate, and **D**elete operations for patients and for doctors, with sensible validation. (Appointments get their create/delete behaviour from the two operations below — no separate CRUD needed there.)

2. **Book an appointment**. Rules that must always hold:
   - Appointments can only be booked in the future, within working hours (09:00–17:00), on a 30-minute slot boundary.
   - A doctor never exceeds 12 appointments in a day.
   - Two patients can never hold the same doctor slot — even when both requests arrive at the same instant.

3. **Cancel an appointment**. Rules:
   - The refund is computed by the server from the notice given: more than 48 hours → 100%; 24–48 hours → 50%; less than 24 hours → 0%. The response states the refund amount.
   - The cancellation and its refund record succeed or fail together.
   - A cancelled slot becomes bookable by another patient, while the cancellation record is kept for refund history.
   - A cancellation notifies the waitlist (Part E).

4. **Doctor statistics** — for a given doctor: revenue collected, upcoming appointment count, appointments per day for the next 7 days, and utilization % against the 12-slot daily cap.

Operations 5 and 6 are where your **advanced SQL** is assessed: the results must be produced by the SQL in your models (joins, aggregates, etc) — not fetched raw and computed in JavaScript.

5. **Doctors report** — every doctor's total appointments and revenue collected, including doctors with zero appointments.
6. **Busy days report** — every (doctor, date) where more than 80% of the 12-slot daily capacity is booked.

### General requirements (all endpoints)

Input validation with meaningful `400` messages; correct status codes (`201`, `404`, `409`, `422`); a central error-handling middleware.

## Part D — Node.js `fs` Module

**Audit log:** every successful booking and cancellation must be appended as a JSON line to `logs/audit.log` using the `fs` module (async, non-blocking — no `*Sync` calls inside request handlers). The logger must create the `logs/` directory on first run if it doesn't exist, and a logging failure must **not** fail the user's request.

## Part E — Queues & Redis

1. **Waitlist queue:** when the requested slot (or the doctor's whole day) is fully booked, offer the patient a waitlist spot — push them onto a queue (Redis list, or Bull/BullMQ). When a cancellation frees a slot, a **worker process** (separate from the web server) pops the first waitlisted patient and books them in. Think through: what happens if the promoted booking itself fails? The patient must not simply vanish from both the queue and the appointments table.
2. **Notification jobs:** every confirmed appointment enqueues a "confirmation SMS/email" job; the worker processes it by writing the message to the audit log (no real sending needed).

## Part F — Unit Testing

Using Jest, write **at least 6 meaningful unit tests**:

- The refund calculator from Part C.3 — cover all three tiers **and both boundaries** (exactly 24 hours, exactly 48 hours). Boundary behaviour must match your documented policy.
- One validation function of your choice — e.g., the slot-alignment/working-hours check — including at least one edge case (17:00 exactly? 09:15? a malformed date?).

Tests must not require a live MySQL or Redis connection — that's the point of extracting pure functions. `npm test` must run them.

## Part G — i18n & l10n: Course Feedback Page

Create a **simple HTML page** (served by your Express app at `GET /feedback`) containing a short course-feedback form with **exactly 5 essay questions** (each answered in a `<textarea>`):

1. Which topic in this course did you find most challenging, and why?
2. Describe one concept you understood only after the practical assignments. What made it click?
3. How has your approach to designing databases or APIs changed since the start of the trimester?
4. What would you improve about how this course was taught or assessed?
5. How do you plan to apply what you learned in this course going forward?

**i18n/l10n requirement (keep it simple):** the page title, instructions, and all 5 questions must be loaded from locale files (e.g., `locales/en.json` and `locales/fr.json` — English plus one other language of your choice). Visiting `/feedback?lang=fr` shows the translated page; the default is English, and an unsupported `lang` value must fall back to English rather than crash. Display today's date on the page formatted for the active locale (e.g., using `Intl.DateTimeFormat`).

---

## Submission Requirements

- Git repository (with meaningful commit history — a single "final commit" will be questioned) containing:
  - `schema-diagram` (image or PDF), `schema.sql`, and `seed.sql` (as specified in Part B)
  - Application source, worker process, tests, locale files
  - `README.md` with: setup steps, `.env.example`, and the short written justifications requested in Parts C, D, and E
- The app must start with `npm install && npm start` (plus documented MySQL/Redis setup) and tests with `npm test`.
- A short **viva/demo (10 minutes)** walkthrough.

**Automatic penalties:** SQL injection vector anywhere in the app (−15), secrets committed to the repo (−5), app does not start per README instructions (−10), work the student cannot explain in the video (or at a follow-up viva if called) | Academic integrity referral; affected criteria re-scored at Developing or below |
