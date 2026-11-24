# MediBook: Clinic Appointment System (backend)

The backend for a clinic's appointment bookings, built with Node.js, Express 5, MySQL 8 and Redis 7.
All SQL goes through `mysql2` with parameterized queries and there's no ORM. Redis holds the
waitlist (plain lists) and the background jobs (BullMQ). The database has exactly 3 tables
(`patients`, `doctors`, `appointments`). There's also a separate worker process, an audit log
written with `fs`, Jest unit tests and a feedback page in English and French.

The original assignment brief is kept, unchanged, below the divider at the end of this file.
The longer reasoning behind each decision is in [`DESIGN_NOTES.md`](DESIGN_NOTES.md). The schema
diagram is [`schema-diagram.png`](schema-diagram.png), a screenshot of [`docs/schema-diagram.html`](docs/schema-diagram.html).
The same design is also in [`docs/schema.dbml`](docs/schema.dbml) (for dbdiagram.io) and as Mermaid in
[`docs/schema-diagram.md`](docs/schema-diagram.md).

## Walkthrough video

[Watch the walkthrough video (Google Drive)](https://drive.google.com/drive/folders/1yvDwgOVo46LXzWo8cpYIiliQwrjxVS3d?usp=sharing)

## Prerequisites

- Node.js 18 or newer, with npm. I developed it on Node 22.
- MySQL 8.0 running locally. I used the Windows service `MySQL80` on port 3306.
- Docker, to run Redis 7 from `docker-compose.yml`. Any Redis from 6.2 up works, because the code needs `LMOVE`.
- Optional: the VS Code REST Client extension, to send the requests in [`requests.http`](requests.http).

## Setup

Run every command from the project root in PowerShell. Steps 3 and 4 use a `$mysql` variable
that's set at the start of step 3, so do both in the same window. The MySQL client usually isn't
on PATH. If you'd rather type `mysql`, add `C:\Program Files\MySQL\MySQL Server 8.0\bin` to PATH
instead of using `$mysql`. Each `-p` asks for that account's password.

**1. Install the dependencies**
```powershell
npm install
```
`npm audit` will mention 2 moderate advisories. They're in `minimatch`, which only nodemon uses
during development. The packages the app actually runs with are clean (`npm audit --omit=dev`
shows 0), so there's no need for `npm audit fix --force`.

**2. Create your `.env`** by copying the template. `.env` is in `.gitignore`, so it never gets committed.
```powershell
Copy-Item .env.example .env
```
Change anything you need to. `DB_USER=medibook_user` and `DB_PASSWORD=change_me` have to match
the MySQL user you create in step 3.

**3. Create the app's own MySQL user.** You only do this once, logged in as root. The app only
reads and writes rows, so this user gets `SELECT, INSERT, UPDATE, DELETE` on `medibook.*` and
nothing more. If you picked a different password in `.env`, use it here instead of `change_me`.
```powershell
$mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
& $mysql -u root -p -e "CREATE USER IF NOT EXISTS 'medibook_user'@'localhost' IDENTIFIED BY 'change_me'; GRANT SELECT, INSERT, UPDATE, DELETE ON medibook.* TO 'medibook_user'@'localhost';"
& $mysql -u root -p -e "SHOW GRANTS FOR 'medibook_user'@'localhost';"
```
It's fine to grant this before the database exists. MySQL stores grants by database name, so
the grant also survives running `schema.sql` again later.

**4. Load the schema and the sample data, as root.** The app user can't do this, because
`schema.sql` starts with `DROP DATABASE IF EXISTS medibook; CREATE DATABASE medibook`. PowerShell
doesn't support `<` redirection, so the commands use the MySQL client's `source` command instead.
```powershell
& $mysql -u root -p --default-character-set=utf8mb4 -e "source database/schema.sql"
& $mysql -u root -p --default-character-set=utf8mb4 -e "source database/seed.sql"
```
If you want to see the constraints working, run this as the app user. It changes nothing,
because everything inside it is rolled back:
```powershell
cmd /c "`"$mysql`" -u medibook_user -p --table --force medibook < database\verify.sql"
```
It goes through `cmd` so that `--force` can carry on past the errors the script expects.
`source` would stop at the first one.

**5. Start Redis** in Docker. It only listens on 127.0.0.1:6379 and keeps its data in a named volume.
```powershell
docker compose up -d
```

**6. Start the API** in one terminal:
```powershell
npm start            # http://localhost:3000   (npm run dev = auto-restart on changes)
```
To check it's working, open `GET http://localhost:3000/api/health`. You should get `{"status":"ok","database":"up"}`.

**7. Start the worker** in a second terminal. It's a separate process that handles waitlist
promotions and the confirmation "SMS" messages.
```powershell
npm run worker
```

**8. Run the unit tests.** They only test pure functions, so MySQL and Redis don't need to be running.
```powershell
npm test
```

**Optional: the concurrency demos**, with the API running:
```powershell
npm run demo:concurrency   # 20 simultaneous bookings for one slot → 1 × 201; daily-cap race → stops at 12
```

**Environment variables.** These go in `.env` (see [`.env.example`](.env.example)): `PORT`,
`CLINIC_TIMEZONE` (Africa/Johannesburg), `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (optional) and `LOG_DIR` (`logs` by default).

**Times.** Appointment times are the clinic's local wall-clock time (`CLINIC_TIMEZONE`), sent and
returned as `"YYYY-MM-DD HH:mm"`. "Now" always comes from Node (`clinicNow()`), never from MySQL's
`NOW()`. The `timestamp` in each audit-log line is in UTC.

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

Every successful JSON response looks like `{ "data": ... }`, and lists also include `"meta"`.
Every error looks like `{ "error": { "status", "message", "details"? } }`.

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

Some example request bodies and responses:

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

[`requests.http`](requests.http) has a request for every endpoint and edge case: a double booking,
the 13th booking of a day, times outside working hours, 09:15, each refund tier, joining the
waitlist and being promoted, the reports and the feedback page.

## Justifications (Parts C, D, E)

### Part C: API and business rules

**REST design.** URLs use plural nouns with the id in the path, and the HTTP method says what
happens. Updates use `PATCH` because you only send the fields that change; `PUT` would mean sending
the whole resource every time. `POST /api/appointments` is its own top-level collection because an
appointment belongs as much to the patient as to the doctor. A doctor's day, waitlist and
statistics are read-only, so they sit under `/api/doctors/:id`.

**Cancelling is `PATCH /api/appointments/:id/cancel`, not `DELETE`.** The appointment isn't
removed. Its status changes, and the row stays for refund history and revenue. The refund is
always worked out by the server and never taken from the client.

**Status codes.** 201 with a `Location` header for anything created, and 204 for a delete.
400 means the request itself is malformed: bad JSON, wrong types, unknown fields, or a date like
`2027-02-30`. 404 is an unknown id or route. 405 is the wrong method on a URL that exists. 409
means the request is valid but clashes with what's already stored: the slot is taken, the day is
full, the email is already used, or the doctor still has appointments. 422 means the request is
well-formed but breaks a business rule: a time in the past, outside 09:00–16:30, on 09:15, an
amount above the fee, or cancelling twice or after the start. 503 means MySQL or Redis is down for
the moment. All of this goes through one error middleware and the `AppError` class. A 500 never
shows the client any internals; the details are logged on the server.

**Deleting patients and doctors.** The foreign keys are `ON DELETE RESTRICT`, so deleting a
patient or doctor who has appointments gives a 409 explaining that appointments are kept as
refund history. Nothing cascades, so financial history can't disappear by accident. MySQL reports
this with two different codes: 1451, which includes the constraint name, and 1217, which doesn't
and is what the least-privilege `medibook_user` gets. The model handles both, so the message is
always the specific one.

**One booking per slot.** `active_slot` is a stored generated column that equals
`appt_datetime` while the appointment is BOOKED and is NULL once it's cancelled. With
`UNIQUE (doctor_id, active_slot)`, two booked rows for the same doctor and time are impossible.
Cancelled rows are NULL, and NULLs never clash, so they don't block anyone rebooking. The same
idea on `(patient_id, active_slot)` stops a patient being booked in two places at once.

**Concurrency.** Each booking is one transaction, and the first thing it does is lock the
doctor's row with `SELECT … FOR UPDATE`. Bookings for the same doctor therefore run one after
another, so "count the day's bookings, then insert" can't be raced. That's what enforces the
12-per-day cap, which no unique index could do. The unique index is still there as the last line
of defense against double booking. `npm run demo:concurrency` shows it working: 20 requests at
once and exactly one gets a 201. Deadlocks and lock timeouts are retried a limited number of
times, then the client gets a 503.

**Refund boundaries.** More than 48 hours' notice gets 100%. From 24 to 48 hours, inclusive,
gets 50%, so exactly 48h and exactly 24h are both 50%: the brief says "more than 48" for the top
tier and "less than 24" for the bottom one. Under 24 hours gets 0%. The amount is calculated in
whole cents and rounded the same way as MySQL's `ROUND(…, 2)`, and a CHECK constraint checks it
again. The status and refund columns are written in a single UPDATE inside one transaction.

**amountPaid.** It defaults to the doctor's fee. A discount anywhere from 0 up to the fee is
allowed, because in the spreadsheet AP-002 paid 120.00 on a 150.00 fee.

**Revenue and utilization.** Revenue is `SUM(amount_paid − refund_amount)`, the money the clinic
actually kept. Utilization is booked ÷ (12 × 7) over the 7 days starting at `?from`, which is
today if it's left out. Every report figure is calculated in SQL, using LEFT JOIN with COALESCE,
conditional COUNT, a recursive CTE so empty days still appear, and HAVING with the cap and the
threshold passed in as parameters.

### Part D: Audit log

`src/services/auditLogger.js` adds one JSON line per event to `logs/audit.log` using
`fs/promises`. It runs `mkdir({ recursive: true })` once, then `appendFile` for each line. There
are no `*Sync` calls, so it never blocks the event loop, and each line is a single small append,
so two lines can't get mixed together. Everything is wrapped in `try/catch`, so if logging fails
the server prints an error and the user's request still succeeds.

There's one exception. For the worker's confirmation job, writing the log line is the whole
point, so it uses `logStrict`. A failed write then fails the job, and BullMQ retries it instead of
marking a lost message as done.

The events are `APPOINTMENT_BOOKED`, `APPOINTMENT_CANCELLED`, `WAITLIST_JOINED`,
`WAITLIST_PROMOTED`, `WAITLIST_PROMOTION_FAILED` and `NOTIFICATION_SENT`. Lines are only written
after the database COMMIT, so the log never records something that was rolled back.

### Part E: Queues and Redis

**Two kinds of Redis use.** The jobs (`slot-freed` and `send-confirmation`) use BullMQ, which
gives retries with exponential backoff and keeps failed jobs to look at. The waitlist itself uses
plain Redis lists: they're strictly first-in, first-out (`RPUSH` to join, `LMOVE … LEFT` to take
the first patient) and easy to inspect through `GET /api/doctors/:id/waitlist`. The keys are
`waitlist:doctor:{id}:slot:{datetime}` for one exact slot and `waitlist:doctor:{id}:day:{date}`
for patients happy with any slot that day. A small Lua script stops the same patient joining
twice, atomically.

**A separate worker process** (`npm run worker`). When someone cancels, the worker takes the
first waiting patient, checking the exact-slot list before the day list. It books them through
the same booking function the API uses, with the same transaction and rules, and then queues
their confirmation.

**A failed promotion never loses the patient.** `LMOVE` moves the entry atomically into a
*processing* list, and it's only removed once the booking has committed. If the error is
temporary (MySQL or Redis trouble), the patient goes back to the front of the list and the job is
retried with backoff. If it can never work (the patient was deleted, or already has another
appointment at that time), the entry moves to `waitlist:failed` with the reason, gets audited,
and the next patient is tried. If someone else took the slot in the meantime, that's not the
patient's fault, so they go back to the front too. When the worker starts, it puts anything left
in a processing list back at the front of its waitlist.

**When Redis is down.** MySQL is the source of truth, so booking and cancelling still work: the
job just isn't queued and a warning is logged. Joining or reading the waitlist gives a 503. A
slot-freed job lost this way is picked up by the worker's waitlist sweep, which runs at start-up
and then every 60 seconds (`WAITLIST_SWEEP_INTERVAL_MS`). Any waiting list whose slot or day has
room gets a new job, so nothing has to be restarted.

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
