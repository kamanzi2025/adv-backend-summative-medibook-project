# MediBook: Design Notes

Plain-language explanations of every design decision, written so each one can be
explained in the video/viva. Sections are added as each phase is built.

---

## 1. Project layout and why it is split this way

```
database/        schema.sql, seed.sql
docs/            diagram sources (DBML + Mermaid)
src/
  config/        env.js (required settings), settings.js (optional CLINIC_TIMEZONE / LOG_DIR),
                 constants.js, db.js, redis.js (settings only, no business logic)
  models/        ALL SQL. The only folder allowed to import config/db.js
  controllers/   business logic: validates input, calls models, picks status codes
  routes/        URL + HTTP method -> controller function
  middleware/    error handler, 404 handler, 405 handler
  validators/    PURE request validation (no DB, no Redis)
  utils/         PURE helpers: clock, AppError, DB-error mapping, refund (no DB, no Redis)
  services/      audit logger, queue producers
  workers/       worker.js, a SEPARATE process (`npm run worker`)
  app.js         builds the Express app (no listen)
  server.js      starts listening (`npm start`)
tests/           Jest unit tests (no MySQL / Redis needed)
locales/         en.json, fr.json for GET /feedback
```

**Why `app.js` and `server.js` are separate:** `app.js` only *builds* the app;
`server.js` *starts* it. Anything (a test, a script) can import the app without
opening a port or a DB connection.

**Why `utils/` must stay pure:** the README says tests must run without MySQL or
Redis. If `utils/refund.js` imported `config/db.js`, simply loading it in a test
would try to connect. Pure utils import nothing except `config/constants.js`,
which itself does no I/O.

**The SQL rule:** only files in `src/models/` import `config/db.js`. Even the
one-line health check (`SELECT 1`) lives in `models/healthModel.js`, and the
controller calls it. That makes the rule easy to verify with a single search.

---

## 2. Configuration and secrets

- **`.env`** holds real values and is gitignored. **`.env.example`** is committed and
  contains only placeholders (`change_me_...`). The `.gitignore` ignores `.env` and
  `.env.*` but re-includes `.env.example`.
- **`config/env.js`** is the only file that reads `process.env` for connection
  settings. It calls `dotenv` once and fails fast with a clear message if a
  required variable (e.g. `DB_USER`) is missing, instead of failing later with a
  cryptic MySQL error.
- **`config/constants.js`** is the single home of every business number: working hours
  (`09:00`–`17:00`), `SLOT_MINUTES = 30`, `DAILY_CAP = 12`, `BUSY_THRESHOLD = 0.8`,
  the refund tiers, the 7-day stats window. Changing a rule means changing one line.
  Objects are `Object.freeze`d so no code can modify a rule at runtime by accident.

---

## 3. Infrastructure: native MySQL + Redis in Docker

**MySQL 8 runs natively** as the Windows service `MySQL80` on port 3306.
**Redis 7 runs in Docker** via `docker-compose.yml`, which contains only Redis.

Why this split:
- **MySQL was already installed and running.** Running a second MySQL in Docker would
  duplicate it and **clash on port 3306**.
- **Redis has no official Windows build.** Docker is the simplest supported way to run a
  real Redis 7 (needed for `LMOVE`, Redis ≥ 6.2) on Windows.

MySQL decisions:
- **The app connects as `medibook_user`, not root** (least privilege): it only has `SELECT,
  INSERT, UPDATE, DELETE` on `medibook.*`, because that's all the code needs. Even a bug or a
  leaked `.env` can therefore never drop tables, change the schema, create users or read
  other databases.
- **The schema scripts are run by hand as root** (or another account allowed to
  `CREATE DATABASE`), because `schema.sql` starts with `DROP DATABASE IF EXISTS medibook;
  CREATE DATABASE medibook;`. That drop/re-create does **not** break `medibook_user`:
  MySQL stores grants by database *name* (`GRANT ... ON medibook.*`) in its own system
  tables, not inside the database, so the grant applies again as soon as `medibook`
  is re-created.

Redis decisions:
- **The port is bound to `127.0.0.1`**, so Redis is reachable from this PC only, not from
  the network. That is why no Redis password is needed locally (`REDIS_PASSWORD` stays
  optional for other environments).
- **`--appendonly yes`** writes every change to disk, so the waitlist survives a Redis
  or Docker restart.
- **`restart: unless-stopped` + a named volume** keep Redis and its data across PC
  reboots.
- **A health check** (`redis-cli ping`) makes `docker compose ps` show `healthy`.

---

## 4. Time zones: the "clinic clock"

**Problem:** the clinic is on Africa/Johannesburg (UTC+2), but a database server's
clock and time zone are configured independently of the app (a MySQL server set to
UTC, or the app deployed on a machine in another zone). If some code used MySQL's
`NOW()` and other code used Node's clock, "is this slot in the future?" and "upcoming
appointments" could disagree by hours.

**Decision:**
1. All appointment times are **clinic wall-clock times** (what the receptionist
   sees on the wall), sent as `"YYYY-MM-DD HH:mm"` and stored in a plain
   `DATETIME` (which has no time zone).
2. **No application query uses `NOW()`, `CURDATE()` or `CURRENT_TIMESTAMP`.** "Now" and
   "today" are computed once in Node by `clinicNow()` in `src/utils/clock.js` and
   passed into SQL as `?` parameters. The validation code, stats, upcoming counts and
   7-day window therefore all use the same clock.
3. `clinicNow()` uses `Intl.DateTimeFormat` with `CLINIC_TIMEZONE` (read by `src/config/settings.js`), so
   the result is correct **whatever time zone the PC or container is in**.
4. Internally a "clinic Date" is a JS `Date` whose **UTC fields hold the clinic's
   wall-clock time** (09:00 Johannesburg is held as `09:00Z`). All arithmetic
   (hours of notice, adding days) uses UTC fields, which have no daylight-saving
   jumps, so it can never be shifted by the host's time zone.
5. mysql2 is configured with `dateStrings: true`, so DATETIME values come back
   as the exact strings that were stored, with no conversion by Node.
6. **Safety net:** the Redis container gets `TZ=Africa/Johannesburg` (from
   `CLINIC_TIMEZONE`), so its logs show clinic time. MySQL's own time zone does not
   matter, because the app never asks MySQL for the time.

`tests/clock.test.js` proves the conversion, including the midnight case where UTC
is still "yesterday" but the clinic is already on "today".

---

## 5. Library choices

| Library | Why |
|---|---|
| `express@5` | REST framework. Version 5 forwards errors from `async` handlers to the error middleware automatically, so no try/catch wrapper is needed in every controller. |
| `mysql2` (promise API) | Required driver. `?` placeholders send values separately from the SQL text, which is what prevents SQL injection. `multipleStatements` stays `false`. |
| `dotenv@16` | Loads `.env`. |
| `ioredis` + `bullmq` | BullMQ gives reliable background jobs (retries with backoff, failed jobs kept for inspection). ioredis is also used directly for the waitlist lists (`RPUSH`, `LMOVE`). |
| `jest` | Unit tests. |
| `nodemon` (dev only) | Auto-restart during development (`npm run dev`). |

**Redis client behaviour (`config/redis.js`):**
- **Web server:** `enableOfflineQueue: false` and `maxRetriesPerRequest: 1`. If Redis is
  down, a Redis command fails **immediately** instead of hanging the HTTP request.
  Booking and cancelling still succeed (MySQL is the source of truth); only the
  follow-up job fails, with a logged warning.
- **Worker:** `maxRetriesPerRequest: null`, as BullMQ workers require, because they use
  blocking commands that wait for jobs.
- **Reconnects:** both retry in the background with a growing delay (capped), and the
  "Redis down" warning is printed once, not on every retry.

---

## 6. Decisions agreed in Phase 1 (implemented in later phases)

| # | Decision | Where |
|---|---|---|
| Slots | 16 possible start times (09:00–16:30), max 12 BOOKED per doctor per day; cancelled rows don't count | Phase 5 |
| Busy day | "> 80% of 12" = more than 9.6, i.e. 10+ bookings. Cap and threshold are passed into SQL as parameters | Phase 9 |
| amount_paid | Defaults to the doctor's fee; optional `amountPaid` from 0 to fee (the spreadsheet shows a discount: AP-002 paid 120 on a 150 fee) | Phase 5 |
| Refund boundaries | > 48h → 100%; 24h–48h inclusive → 50%; < 24h → 0%. Integer-cent arithmetic | Phase 6 |
| Cancel endpoint | `PATCH /api/appointments/:id/cancel`. The record is kept, so `DELETE` would be misleading | Phase 6 |
| Revenue | `SUM(amount_paid − COALESCE(refund_amount, 0))`: money actually kept | Phase 9 |
| Utilization | booked ÷ (12 × 7) over the same next-7-days window | Phase 9 |
| Delete with history | FK `ON DELETE RESTRICT` → 409; refund history is never lost | Phase 4 |
| Patient double-booking | A patient can't hold two BOOKED appointments at the same time (with any doctors) | Phase 3/5 |
| appt_ref | Format `AP-YYYYMMDD-XXXX` (appointment date + 4 random `0-9A-Z` characters). Generated in Node **before** the insert, retried on a duplicate-key error on the `uq_appt_ref` index. No insert-then-update on a NOT NULL UNIQUE column | Phase 5 |
| Waitlist | Redis lists per doctor + slot and per doctor + day; FIFO (`RPUSH` / `LMOVE … LEFT`); reliable pop via a processing list; transient vs permanent failure classes; `waitlist:failed`; startup recovery; duplicate prevention; `GET /api/doctors/:id/waitlist` | Phase 8 |
| Redis down | Booking/cancelling still succeed; joining the waitlist → 503. A lost "slot-freed" job is recovered by the worker's waitlist sweep (start-up + every 60 s) | Phase 8 |
| Feedback date format | `en-GB` and `fr-FR` | Phase 10 |
| Statistics window start | `GET /api/doctors/:id/statistics` accepts an optional `?from=YYYY-MM-DD` (validated, 400 if malformed); default = today from `clinicNow()`. The seed appointments are in March 2027, so the default "next 7 days" would be all zeros in a demo; `?from=2027-03-15` shows the busy week. The SQL still receives the window dates as `?` parameters | Phase 9 |
| Demoing the 50% / 0% refund tiers | Seeded cancellations can only be 100% (see §9). `requests.http` will book appointments live for tomorrow / the day after through the API and then cancel them, showing the 0% (< 24h) and 50% (24–48h) tiers | Phase 12 |

---

## 7. Normalization: from the spreadsheet to 3NF

### What was wrong with the spreadsheet

| appt_ref | patient_name | patient_email | patient_phone | doctor_name | specialty | consultation_fee | room | … | amount_paid |
|---|---|---|---|---|---|---|---|---|---|
| AP-001 | Ama Mensah | ama@mail.com | 0244-111-222 | Dr. Boateng | Dermatology | 150.00 | R-12 | … | 150.00 |
| AP-002 | Kojo Owusu | kojo@mail.com | 0555-333-444 | Dr. Boateng | Dermatology | 150.00 | R-12 | … | 120.00 |
| AP-003 | Ama Mensah | ama@mail.com | 0244-111-222 | Dr. Adjei | Paediatrics | 100.00 | R-03 | … | 100.00 |

- **Redundancy:** Ama's name, email and phone are typed again on every appointment
  she makes. Dr. Boateng's specialty, fee and room are repeated on every one of his
  appointments.
- **Update anomaly:** if Ama changes her phone number, every one of her rows must be
  changed. Miss one and the data contradicts itself.
- **Insert anomaly:** a new doctor can't be recorded until someone books with them
  (there is no row to put them in). That's exactly the "doctor with zero appointments"
  case the reports must show.
- **Delete anomaly:** deleting a patient's only appointment also deletes the only
  record of that patient (and possibly of a doctor).

### How each normal form is satisfied

**1NF: atomic values, no repeating groups, a key per row.**
Every cell holds one value (one phone, one datetime). There are no lists like
"slot1, slot2". Every table has a primary key (`id`).

**2NF: no partial dependency on part of a key.**
Every table uses a single-column surrogate key (`id`). A partial dependency needs a
*composite* key, so with single-column keys 2NF holds automatically. In spreadsheet
terms: `patient_email` depended only on the patient, not on the whole appointment,
so the patient columns moved to `patients`. Likewise the doctor columns moved to
`doctors`.

**3NF: no transitive dependency (non-key → non-key).**
In the spreadsheet `appt_ref → doctor_name → specialty, consultation_fee, room`:
the fee depended on the doctor, not on the appointment. So `specialty`,
`consultation_fee` and `room` now live only in `doctors`, and `appointments` keeps
just `doctor_id`. Similarly `appt_ref → patient_email → patient_name, patient_phone`,
so those live only in `patients`.

### Why `amount_paid` stays on `appointments` (and is NOT redundant)

AP-002 paid **120.00** on a **150.00** fee. So `amount_paid` is a fact about *that
appointment* (what was actually charged, e.g. after a discount), not about the doctor.
Also, the fee may change next year, but what was paid last year must not change. A
column is only redundant if it can be derived from other columns, and `amount_paid`
can't be.

### Why cancellation and refund data are columns, not tables

The brief allows exactly 3 tables. `status`, `cancelled_at`, `refund_percent` and
`refund_amount` each depend on the appointment (its key) and nothing else, so putting
them on `appointments` is still 3NF. A cancelled appointment has exactly one
cancellation and one refund, a 1:1 fact about the row.

### `refund_percent` and `refund_amount`: isn't one derivable from the other?

`refund_amount = amount_paid × refund_percent / 100`. We store both because the
amount is the money actually returned (the audit record finance needs). The CHECK
`chk_appt_refund_matches_percent` makes it impossible for them to disagree, so the
usual risk of storing derived data (inconsistency) is removed by the database itself.

### Candidate keys
- `patients.email` is UNIQUE, so it's a candidate key. `id` is still the PK because
  emails can change and are long to use as foreign keys.
- `doctors.room` is UNIQUE (each doctor has their own consulting room).
- `appointments.appt_ref` is UNIQUE: the human-readable reference, a candidate key.

---

## 8. Schema design decisions (`database/schema.sql`)

### Types
| Column(s) | Type | Why |
|---|---|---|
| ids | `INT UNSIGNED AUTO_INCREMENT` | never negative; 4 billion rows is plenty |
| money (`consultation_fee`, `amount_paid`, `refund_amount`) | `DECIMAL(10,2)` | exact decimal arithmetic. `FLOAT` would store 0.1 as 0.1000000001 |
| `appt_datetime`, `booked_on`, `cancelled_at` | `DATETIME` | stores clinic wall-clock time exactly as given. `TIMESTAMP` would convert through the session time zone (see §4) |
| `status` | `ENUM('BOOKED','CANCELLED')` | only two legal values, enforced by MySQL, 1 byte |
| `refund_percent` | `TINYINT UNSIGNED` | 0–100 fits in 1 byte |
| `email` | `VARCHAR(254)` | maximum length of an email address in the SMTP standard |
| `appt_ref` | `VARCHAR(16)` | `AP-` + 8-digit date + `-` + 4 characters = 16 |

Character set `utf8mb4` with `utf8mb4_0900_ai_ci`: stores any name (accents, any
script). The `_ci` (case-insensitive) collation also means `AMA@mail.com` and
`ama@mail.com` count as the **same** email for `uq_patient_email`.

### The slot rule: generated column + UNIQUE index

```sql
active_slot DATETIME GENERATED ALWAYS AS
  (CASE WHEN status = 'BOOKED' THEN appt_datetime ELSE NULL END) STORED,
CONSTRAINT uq_appt_doctor_active_slot UNIQUE (doctor_id, active_slot)
```

- **The problem:** a plain `UNIQUE(doctor_id, appt_datetime)` would block a slot
  forever once anyone had booked it, *even after cancelling*, because the cancelled
  row is kept for refund history. Deleting the cancelled row would lose that history.
- **The trick:** MySQL computes `active_slot` itself. It equals the slot time while the
  appointment is BOOKED and becomes NULL the moment it's CANCELLED. A UNIQUE index treats
  every NULL as different from every other NULL, so:
  - two BOOKED rows for the same doctor + time → same `active_slot` → **ERROR 1062**;
  - any number of CANCELLED rows for that time → all NULL → **allowed**.
- **Why STORED (not VIRTUAL):** the value is written to disk and indexed like a normal
  column, so the UNIQUE check is a plain index lookup.
- **Why this is the final guarantee under concurrency:** even if two requests pass every
  check in Node at the same instant, InnoDB lets only one of them insert that index key.
  The other gets ERROR 1062, which the API turns into **409 Conflict** (Phase 5).
- The **same trick** gives `uq_appt_patient_active_slot`: a patient can't be in two
  places at once.

### CHECK constraints: the database's own last line of defence

MySQL 8.0.16+ **enforces** CHECK constraints (older versions parsed and ignored them).
The API validates everything first and returns friendly 400/422 messages. The CHECKs
exist so that **no** path (a bug, a manual SQL edit, a future script) can store an
impossible row.

- **Slot shape:** `chk_appt_slot_minutes`, `chk_appt_slot_seconds`, `chk_appt_working_hours`.
  The literals `'09:00:00'`, `'16:30:00'` and `(0, 30)` deliberately mirror
  `WORKING_HOURS_START`, `WORKING_HOURS_END − SLOT_MINUTES` and `SLOT_MINUTES` in
  `src/config/constants.js`. SQL DDL can't read JS constants, so if the clinic's
  hours ever change, both must be updated.
- **Why "future only" is NOT a CHECK:** MySQL forbids non-deterministic functions such
  as `NOW()` in CHECK constraints (the answer would change over time). "Future" is
  therefore enforced in the booking code using `clinicNow()`. The deterministic part
  of it *is* checked: `chk_appt_booked_before_slot` (`booked_on < appt_datetime`).
- **Why "≤ 12 per day" is NOT a CHECK:** a CHECK can only see the row being written, not
  count other rows. It's enforced in the booking transaction (Phase 5).
- **Why "amount_paid ≤ fee" is NOT a CHECK:** a CHECK can't read another table
  (`doctors`). The booking controller enforces it.
- **Status consistency** (`chk_appt_status_consistency`): a BOOKED row can't carry a
  refund, and a CANCELLED row must carry `cancelled_at` + `refund_percent` +
  `refund_amount` **together**. This backs up the README rule that "the cancellation
  and its refund record succeed or fail together": a half-cancelled row is
  impossible at the database level.
- **NULL behaviour:** a CHECK only *fails* when its expression is FALSE; NULL counts as
  passing. So `chk_appt_refund_within_paid` (`refund_amount BETWEEN 0 AND amount_paid`)
  automatically allows BOOKED rows, whose refund is NULL.

### Foreign keys: `ON DELETE RESTRICT`

`fk_appt_patient` and `fk_appt_doctor` use RESTRICT: MySQL refuses to delete a patient or
doctor who has appointments (even cancelled ones). Refund history must never vanish
or point at nothing. The API reports this as **409 Conflict** (Phase 4).
`ON DELETE CASCADE` would silently delete financial history; `SET NULL` would be
impossible because the FK columns are NOT NULL (every appointment needs a patient
and a doctor).

### Constraint names

Every constraint has a name (`pk_`, `uq_`, `chk_`, `fk_`, `idx_` prefixes) so the error
messages, the diagram, the SQL and the video all use the same words. For example,
MySQL's error says `Duplicate entry ... for key 'appointments.uq_appt_doctor_active_slot'`,
and the API code can recognise which rule fired from the name.
(MySQL always calls the primary key index `PRIMARY`. The `pk_` names document intent
in the script and diagram.)

### Index

`idx_appt_doctor_datetime (doctor_id, appt_datetime)` speeds up "how many BOOKED
appointments does doctor X have on day Y", which runs on every booking and in every
report. The FK columns are already indexed by the two UNIQUE indexes (both start with
the FK column), which InnoDB requires for foreign keys.

### `schema.sql` resets the database

It starts with `DROP DATABASE IF EXISTS medibook; CREATE DATABASE medibook; USE medibook;`
so it always produces a clean, known state, and must be run as root (or another
account allowed to create databases). The app user `medibook_user` keeps working
afterwards because grants are stored by database *name* (see §3).

---

## 9. Seed data (`database/seed.sql`)

| What the rubric needs | Where it is in the seed |
|---|---|
| ≥ 3 patients | 11 patients (ids 1–11). Ama and Kojo use the spreadsheet's emails |
| ≥ 3 doctors, one with no appointments | Dr. Boateng (1), Dr. Adjei (2), **Dr. Owusu-Ansah (3) has zero** |
| ≥ 8 appointments | 16 (14 BOOKED, 2 CANCELLED) |
| A doctor-day at/near the 12 cap | **Dr. Boateng, 2027-03-15: 11 BOOKED** (09:00–14:00) = 91.7% > 80%, so it's in the busy-days report. Booking #12 succeeds, #13 is rejected |
| A cancellation with a refund that follows the policy | Appointment 12 (150.00 → 100% = 150.00) and 16 (120.00 → 100% = 120.00), both cancelled months ahead, i.e. > 48h notice → 100% |
| The AP-002 discount | Appointment 2: Kojo paid **120.00** on a **150.00** fee (also appointment 16) |
| Cancelled slot is re-bookable | Appointment 12 (CANCELLED) and appointment 1 (BOOKED) are in the **same** slot, Dr. Boateng 2027-03-15 09:00 |

Decisions:
- **Explicit ids** so the demo requests (`/api/doctors/1`, `/api/appointments/12`) are
  predictable. Inserted in FK-safe order: patients, doctors, appointments.
- **One transaction** (`START TRANSACTION … COMMIT`): if any row breaks a constraint,
  nothing is half-loaded.
- **Appointment dates are in 2027**, so they're in the future and can be cancelled or
  rebooked live. **`booked_on` / `cancelled_at` are in November 2026 (the past)**:
  they record things that already happened, and a booking can't have been recorded
  in the future.
- **Why the seed only shows 100% refunds:** a 50% or 0% refund needs a cancellation
  less than 48h before the appointment. With 2027 appointments and past cancellation
  dates, that's impossible without inventing future events. The 50% and 0% tiers are
  demonstrated live through the API (book an appointment for tomorrow, then cancel it)
  and in the unit tests.
- **Expected report numbers** (useful in the video):
  revenue Dr. Boateng = 10 × 150 + 120 = **1620.00** (the cancelled ones were fully
  refunded, so they add 0); Dr. Adjei = 3 × 100 = **300.00**; Dr. Owusu-Ansah = **0.00**.

`database/verify.sql` is a demo script that proves the constraints work. It tries
the forbidden inserts inside a transaction and then `ROLLBACK`s, so no rows change.
Two things to know when demoing it:
- Run it through stdin with `--force`: ``cmd /c "`"$mysql`" -u medibook_user -p --table --force medibook < database\verify.sql"``
  (where `$mysql` is the full path to `mysql.exe`, as in the README).
  The client's `source` command stops at the first error even with `--force`.
- Afterwards the next appointment id is 21, not 17. InnoDB hands out an AUTO_INCREMENT
  value to every attempted insert and doesn't give it back on error or ROLLBACK. Gaps
  in ids are normal and harmless, which is one reason the human-facing identifier is
  `appt_ref`, not `id`.

---

## 10. REST API design: patients and doctors (Phase 4)

### Endpoints

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/patients?limit=&offset=` | 200 `{ data: [...], meta: { limit, offset, total } }` | 400 bad pagination |
| POST | `/api/patients` | 201 + `Location: /api/patients/{id}` + `{ data }` | 400, 409 duplicate email |
| GET | `/api/patients/:id` | 200 `{ data }` | 400 bad id, 404 |
| PATCH | `/api/patients/:id` | 200 `{ data }` (the updated row) | 400, 404, 409 duplicate email |
| DELETE | `/api/patients/:id` | 204 (no body) | 400, 404, 409 has appointments |
| … | `/api/doctors` and `/api/doctors/:id` | same pattern | 409 duplicate room / has appointments |

### Why these REST choices

- **Plural nouns for collections, ids for items** (`/api/patients`, `/api/patients/7`).
  The HTTP *method* says what happens, so there are no verbs in the URL
  (`/getPatient`, `/deletePatient`).
- **`/api` prefix:** separates the JSON API from the HTML page (`GET /feedback`, Phase 10).
- **PATCH, not PUT.** PUT means "replace the whole resource": the client would have to
  resend every field just to change a phone number, and a missing field would
  arguably mean "erase it". PATCH means "change just these fields", which is what a
  receptionist actually does. Rules: any subset of the fields, **at least one**, no
  unknown fields, and no `null` (every column is NOT NULL).
- **PUT and other unsupported methods get 405 Method Not Allowed** with an `Allow`
  header (e.g. `Allow: GET, PATCH, DELETE`), not 404. The URL *does* exist, only the
  method is wrong. Unknown URLs get 404.
- **201 + `Location`** on create: the standard way to tell the client where the new
  resource lives.
- **204 No Content** on delete: the resource is gone, so there's nothing to return.
  It's used consistently for both patients and doctors.
- **Every success body is `{ data: ... }`**, and lists add `meta`. Every error is
  `{ error: ... }`. A client can tell success from failure by the top-level key alone,
  and adding pagination info later never breaks the shape.
- **camelCase JSON, snake_case SQL:** JavaScript convention outside, SQL convention
  inside. The *model* maps one to the other (`toPatient(row)`), so controllers never
  see column names.
- **Pagination:** `limit` defaults to 20 with a maximum of 100 (`PAGINATION` in
  constants), and `offset` defaults to 0. Without a maximum, `?limit=100000000` could
  make the server load a whole table into memory. `meta.total` lets a client show
  "page 2 of 6".

### Status codes

| Code | When | Example |
|---|---|---|
| 200 | successful read / update | `GET /api/patients/1` |
| 201 | created | `POST /api/patients` |
| 204 | deleted | `DELETE /api/patients/13` |
| 400 | the request itself is malformed: bad JSON, wrong types, missing/unknown fields, bad id format, bad pagination | `GET /api/patients/abc` |
| 404 | the id or route doesn't exist | `GET /api/patients/9999`, `GET /api/nope` |
| 405 | the URL exists but not with that method | `PUT /api/patients/1` |
| 409 | the request is valid but conflicts with existing data | duplicate email, room taken, deleting a doctor who has appointments |
| 413 | body larger than 100 KB | protects the server from huge uploads |
| 422 | (Phase 5+) well-formed but breaks a business rule | booking in the past, at 09:15, cancelling twice |
| 500 | a bug; the details are hidden from the client and logged to the console | |
| 503 | MySQL unreachable or rejecting the login | "The database is temporarily unavailable" |

**400 vs 422:** 400 means "I can't even understand this request" (syntax, types,
shape). 422 means "I understand it, but the rules say no" (meaning). `/api/patients/abc`
is a 400 because `abc` isn't an id at all; booking 09:15 is a 422 because it's a real,
well-formed time that the clinic's rules reject.

**Why `/api/patients/abc` is 400 but `/api/patients/9999` is 404:** `abc` can never be
an id (bad input), while 9999 *could* be one, it just doesn't exist (yet).

### Validation (`src/validators/`)

- **Pure functions**, so they can be unit-tested with no database.
  `validateBody(body, rules, { partial })` checks a body against a map of field rules
  and **collects every problem before failing**, so the client sees all of them in one
  response:
  ```json
  { "error": { "status": 400, "message": "Invalid patient: check fullName, email, phone",
      "details": [ { "field": "fullName", "message": "is required" },
                   { "field": "email", "message": "must be a valid email address, e.g. name@example.com" },
                   { "field": "phone", "message": "is required" } ] } }
  ```
- **Strings are trimmed** before checking, so `"   "` is "blank" and `" Ama "` is stored as `"Ama"`.
- **Maximum lengths come from `FIELD_LIMITS` in constants**, which mirror the column
  sizes (`VARCHAR(100)`, etc.). Length is counted in *characters* (`[...text].length`),
  like MySQL's `CHAR_LENGTH`, so an emoji counts as 1.
- **Email** is lower-cased, and its format check matches the DB rule `chk_patient_email_format`.
  **Phone** uses the same pattern as `chk_patient_phone_format`. **Room** is upper-cased
  and must look like `R-12`.
- **`consultationFee`** must be a JSON *number* (not the string `"100"`), > 0, with at most
  2 decimals, and ≤ 99,999,999.99 (the largest `DECIMAL(10,2)`).
- **Unknown fields are rejected** (`"age": 30` → 400). This catches typos like
  `"fullname"` that would otherwise be silently ignored.
- **ids** must match `^[1-9][0-9]*$` and fit `INT UNSIGNED`. That rejects `abc`, `0`,
  `-1`, `1.5` and `1e3`.
- **The database CHECKs remain the last line of defence** (§8). The validators give
  friendly messages; the CHECKs guarantee nothing slips through.

### The SQL in the models

- **Every value is a `?` placeholder** (`pool.execute`, a real prepared statement).
  The SQL text is always a fixed string literal: no `${...}`, no `+`.
- **PATCH without dynamic SQL:** a partial update usually tempts people to build
  `SET col1 = ?, col2 = ?` from whichever fields were sent, which is string-built SQL.
  Instead each model has **one fixed statement**:
  ```sql
  UPDATE patients SET full_name = COALESCE(?, full_name),
                      email     = COALESCE(?, email),
                      phone     = COALESCE(?, phone)
   WHERE id = ?
  ```
  A field that wasn't sent is passed as `NULL`, and `COALESCE(NULL, full_name)` keeps
  the current value. It's safe because every column is NOT NULL, so NULL is never a
  real new value (and the validator rejects `null` from the client). It is also
  **atomic**: there's no "read the row, merge in JS, write it back" window in which
  another request could change it.
- **404 on update without an extra query:** mysql2 turns on the `CLIENT_FOUND_ROWS`
  flag, so `affectedRows` counts rows *matched* by `WHERE id = ?`, even if nothing
  changed. `0` means the id doesn't exist, which becomes a 404.
- **`LIMIT ? OFFSET ?` values are sent as strings.** MySQL 8 rejects JavaScript numbers
  (sent as DOUBLE) for LIMIT placeholders in prepared statements. They're still
  placeholders: the values never touch the SQL text.

### Delete behaviour: 409, never cascade

`fk_appt_patient` / `fk_appt_doctor` are `ON DELETE RESTRICT`, so MySQL refuses the
DELETE and the API answers **409**: *"Doctor 1 has appointments and cannot be deleted.
Appointments (including cancelled ones) are kept permanently as refund history."* A
patient or doctor with **no** appointments (e.g. seeded Dr. Owusu-Ansah) deletes normally
with 204. The model doesn't need to check first: it attempts the DELETE and lets the
database enforce the rule. A check-then-delete would also have a race (an appointment
booked between the check and the delete).

MySQL reports this refusal with **two different codes** depending on the user's privileges:
`ER_ROW_IS_REFERENCED_2` (1451, includes the constraint name) for a user who may read the
child table's definition, and `ER_ROW_IS_REFERENCED` (1217, no name) for the least-privilege
`medibook_user`. So the model does not parse the constraint name: `remove()` catches either
code (`isRowReferenced()` in `dbErrorMap.js`) and returns `REMOVE_OUTCOME.HAS_APPOINTMENTS`,
and the controller, which knows whether it is a patient or a doctor, writes the message.

### Errors: `AppError` + one central middleware

- **`AppError`** (`src/utils/AppError.js`) is an `Error` that carries an HTTP status and
  optional `details`, with factory helpers: `AppError.badRequest(...)`, `.notFound`,
  `.conflict`, `.unprocessable`, `.serviceUnavailable`. Controllers just
  `throw AppError.notFound('Patient 9999 not found')`.
- **No try/catch in controllers:** Express 5 automatically passes a rejected promise
  from an `async` handler to the error middleware. Every controller is plain
  "validate → call model → respond".
- **`errorHandler`** (`src/middleware/errorHandler.js`) is the **only** place that turns
  an error into a response. It handles, in order:
  1. `AppError`: used as-is;
  2. invalid JSON from `express.json()` → 400 "Malformed JSON in request body"; body over 100 KB → 413;
  3. known MySQL errors via `mapDbError` (`src/utils/dbErrorMap.js`, a pure function):
     - `ER_DUP_ENTRY` → 409. The **constraint name** is read from MySQL's message
       (`for key 'patients.uq_patient_email'`) and mapped to a friendly message plus
       the field (`email`), which is why every constraint has a name.
     - `ER_ROW_IS_REFERENCED_2` → 409 with the refund-history explanation.
     - `ER_NO_REFERENCED_ROW_2` → 404; `ER_CHECK_CONSTRAINT_VIOLATED` / `ER_DATA_TOO_LONG` → 400.
     - connection or login failures (`ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, …) → 503.
  4. anything else → **500 "Internal server error"**. The real error and stack trace are
     printed to the server console only, so internal details (SQL, file paths) never
     leak to a client.
- **One error shape everywhere:** `{ "error": { "status", "message", "details"? } }`, for
  validation errors, 404 routes, 405, DB conflicts and 500s alike.
- **Middleware order in `app.js`:** routes → `notFound` (any unmatched URL) →
  `errorHandler` (last, because Express only reaches it when something called
  `next(err)` or threw).

---

## 11. Booking (Phase 5)

### Endpoints

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/api/appointments` | 201 + `Location: /api/appointments/{id}` | 400, 404, 409 (+ waitlist offer), 422, 503 |
| GET | `/api/appointments/:id` | 200, with patient and doctor names | 400, 404 |
| GET | `/api/doctors/:id/appointments?date=YYYY-MM-DD` | 200 + `meta: { booked, dailyCap, remaining }` | 400, 404 |

Request body: `{ "patientId": 5, "doctorId": 2, "appointmentDateTime": "2027-05-03 10:00",
"amountPaid": 80 (optional), "joinWaitlist": true (optional) }`.

**Why `POST /api/appointments` and not `POST /api/doctors/2/appointments`:** an
appointment belongs equally to a patient and a doctor, so neither is its "parent".
A top-level collection keeps one URL per appointment (`/api/appointments/17`), which
is also where cancellation goes (`PATCH /api/appointments/17/cancel`, Phase 6).
`GET /api/doctors/:id/appointments?date=` is a *read-only view* of one doctor's day,
handy for demos and for a receptionist's screen.

### The order of checks, and which status each one gets

```
1. Body shape            -> 400  validateBookingBody (pure): types, required fields,
                                  unknown fields, strict "YYYY-MM-DD HH:mm", real
                                  calendar date (rejects 2027-02-30)
2. Clinic slot rules     -> 422  slotRuleViolations(slot, clinicNow()) (pure):
                                  future, 09:00-16:30, :00/:30 (ALL broken rules listed)
--- transaction (appointmentModel.bookAppointment) ---
3. Doctor exists         -> 404  SELECT ... FOR UPDATE (also takes the lock)
4. Patient exists        -> 404
5. amountPaid <= fee     -> 422
6. Daily cap (12)        -> 409  + waitlist offer, type "day"
7. INSERT                -> 409  + waitlist offer, type "slot" (uq_appt_doctor_active_slot)
                         -> 409  patient already busy then (uq_appt_patient_active_slot)
COMMIT -> 201, then audit log + confirmation job
```

- **400 vs 422:** `"2027-02-30 10:00"` and `"abc"` aren't valid times at all, so they're
  400 (malformed). `"2027-05-03 09:15"` is a perfectly valid time that the clinic's rules
  forbid, so it's 422. Same idea as §10.
- **404:** the request names a patient or doctor that doesn't exist. The URL itself is
  fine, so it's 404 for the referenced resource, not 400.
- **409:** the request is valid, but it collides with the *current state* of the data
  (slot taken, day full, patient already busy). Retrying later could succeed, which is
  exactly when a waitlist makes sense.
- **422 for amountPaid > fee:** it's a rule about meaning ("never charge above the fee"),
  not about syntax. A negative or 3-decimal `amountPaid` is a 400 (bad shape).
- **Cheap checks first:** the pure checks (1–2) need no database, so bad requests are
  rejected before a connection or lock is ever taken.

### Concurrency strategy: two layers

**Layer 1: `SELECT ... FROM doctors WHERE id = ? FOR UPDATE` (serialization).**
This row lock makes every booking *for the same doctor* wait in line, one transaction
at a time. Inside the lock, "count today's BOOKED appointments, then insert" is safe,
because nobody else can be between the count and the insert for that doctor.

*Without it, the daily cap breaks.* Two requests for different free slots on a day
with 11 bookings both run `COUNT(*)`, both see 11 (< 12), and both insert: 13
appointments. No UNIQUE index can stop this, because the two rows are for
*different* times. `scripts/concurrency-daily-cap.js` proves the fix: 6 simultaneous
requests for 6 different slots with room for 2 → exactly 2 succeed and the day stops
at 12.

*Why lock the doctor row and not the appointments?* A doctor row always exists, even
on an empty day, so there is always something to lock. Locking "all appointments of
that day" (`SELECT ... FOR UPDATE` on a range) would rely on InnoDB gap locks, which are
harder to reason about and deadlock-prone. Bookings for *different* doctors lock
different rows, so they still run in parallel.

**Layer 2: `UNIQUE (doctor_id, active_slot)` (the final guarantee).**
Even if the lock were removed, forgotten in some future code path, or bypassed by a
manual INSERT, the database itself refuses a second BOOKED row for the same doctor and
time (`ER_DUP_ENTRY`), and the API turns it into 409 "slot taken".

*Without it,* correctness would depend on every code path remembering to take the
lock. A unique index can't be "forgotten". `scripts/concurrency-same-slot.js` fires 20
simultaneous requests for one slot → exactly one 201 and nineteen 409.

**Why both?** The lock fixes the race that the index *can't* (the cap, across
different slots). The index guarantees the rule that matters most (no double
booking), *no matter what*. `uq_appt_patient_active_slot` does the same for "a patient
can't be in two places at once", even across two doctors (different doctor locks,
same patient).

**READ COMMITTED for the booking transaction.** Under MySQL's default REPEATABLE READ,
plain reads use a snapshot. Setting READ COMMITTED for this transaction guarantees that
once the doctor lock is held, the `COUNT(*)` sees every booking committed by the
transaction that held the lock before. The count can never be stale.

**Sargable day range.** "That day" is `appt_datetime >= '2027-03-15 00:00:00' AND
appt_datetime < '2027-03-16 00:00:00'`, not `DATE(appt_datetime) = ?`. Wrapping the
column in a function would stop MySQL from using `idx_appt_doctor_datetime (doctor_id,
appt_datetime)`. Both bounds are computed in Node (`dayRange()` in `utils/clock.js`) and
passed as `?`. No `NOW()` or `CURDATE()` (§4).

**Transaction hygiene.** One connection from the pool per attempt. Every early exit
(doctor/patient missing, over fee, day full) calls `ROLLBACK`; any thrown error is also
rolled back; `finally` always `release()`s the connection back to the pool, so a failed
booking can never leak a connection or leave a lock held.

**Deadlocks and lock timeouts: bounded retry, then 503.** `ER_LOCK_DEADLOCK` and
`ER_LOCK_WAIT_TIMEOUT` are transient: the same request would very likely succeed a
moment later. InnoDB has already rolled the victim back, so the model simply retries the
*whole* transaction, up to `BOOKING_MAX_ATTEMPTS = 3` attempts in total. If it still fails,
the error reaches the middleware and becomes **503 "The clinic is very busy right now.
Please try again in a moment."** (503 = temporary, try later). Business outcomes (slot
taken, day full) are **never** retried: they're answers, not glitches.

**Outcomes instead of exceptions.** `bookAppointment()` returns
`{ outcome: 'BOOKED' | 'DOCTOR_NOT_FOUND' | 'PATIENT_NOT_FOUND' | 'AMOUNT_EXCEEDS_FEE' |
'DAY_FULL' | 'SLOT_TAKEN' | 'PATIENT_DOUBLE_BOOKED' }` and only *throws* for unexpected
database errors. The model knows nothing about HTTP. The controller maps outcomes to
404/409/422, and the Phase 8 worker will map the same outcomes to "permanent failure,
try the next waitlisted patient". A thrown error means "transient, put the patient back".
One model function, two callers, identical rules.

### appt_ref: generated before the insert

`AP-YYYYMMDD-XXXX` (e.g. `AP-20270503-Y97V`): the appointment date plus 4 random characters
from `0-9A-Z` (36⁴ ≈ 1.7 million codes per day), using `crypto.randomInt`. It's created in
Node **before** the INSERT, so `appt_ref` is NOT NULL and UNIQUE from the very first
moment. There's no insert-then-update window in which the row exists without a reference.
If two bookings ever drew the same code, the INSERT fails on `uq_appt_ref`, and the model
generates a *new* code and retries (bounded by `BOOKING_MAX_ATTEMPTS`). The function takes
an injectable random source, so it's deterministic in unit tests.

### amountPaid

- **Default = the doctor's current `consultation_fee`**, read *inside* the transaction
  under the doctor lock, so the fee used is the one in force at booking time.
- **Optional `amountPaid`** for discounts (the spreadsheet's AP-002 paid 120.00 on a 150.00
  fee): it must be a JSON number with at most 2 decimals and `0 ≤ amountPaid ≤ fee`.
  0 = a free visit.
- Shape errors (negative, `"50"`, 3 decimals) → **400**. Above the fee → **422**.
- The comparison is done in **integer cents** (`toCents`), so floating-point noise
  can never decide whether 150.00 > 150.
- The *fee* rule can't be a CHECK constraint (a CHECK can't read `doctors`), which is why
  it lives in the booking code. `chk_appt_amount_paid_non_negative` still guards ≥ 0 in
  the database.

### The waitlist offer on 409

"Slot taken" and "day full" answer:
```json
{ "error": { "status": 409, "message": "Doctor 2 is already booked at 2027-05-03 10:00",
    "waitlistAvailable": true, "waitlistType": "slot",
    "hint": "Resend the same request with \"joinWaitlist\": true to join the waitlist for this slot." } }
```
- `waitlistType: "slot"` = the exact time was taken (wait for *that* slot).
  `"day"` = the whole day hit 12 (wait for *any* slot that frees up that day).
- **Opt-in by resending with `"joinWaitlist": true`**: the booking is always attempted
  first, and only if it is *still* full does the patient join the waitlist (202
  Accepted). If the slot freed up in the meantime, they simply get the appointment
  (201). One endpoint, and no stale "join" decisions.
- "Patient already has an appointment at that time" gets **no** offer: waiting wouldn't help.
- Until Phase 8, `waitlistService.joinWaitlist()` is the single place that answers 503
  ("waitlist not available yet").

### After the commit, and only then

`bookingEvents.onAppointmentBooked(appointment, { source })` writes the
`APPOINTMENT_BOOKED` audit entry (Phase 7) and queues the confirmation job (Phase 8).
It's called only after `COMMIT` succeeded. Logging "booked" for a booking that then
rolled back would be a lie, and a confirmation SMS for it would be worse. Both steps
never throw: the booking is already saved, so a logging or Redis failure must not turn
a success into a 500. The worker will reuse the same function for promoted bookings
(`source: 'waitlist'`).

### Demo scripts (`scripts/`)

`npm run demo:same-slot`, `npm run demo:daily-cap` and `npm run demo:concurrency` (both)
call the **running API** over HTTP, so no SQL lives outside the models. Each run creates
the demo patients it needs (`demo.patient.NN@medibook.test`) and picks the **first empty
day** for doctor 2 from June/July 2027, so they can be re-run in the video without
reloading the database. They print PASS or FAIL and exit with code 1 on failure.

---

## 12. Cancellation and refunds (Phase 6)

`PATCH /api/appointments/:id/cancel` with no body (or `{}`).

**Why PATCH, not DELETE:** cancelling *changes the state* of the appointment (status,
`cancelled_at`, `refund_percent`, `refund_amount`). The row is kept forever as refund history
and for revenue. `DELETE` would tell the client the resource is gone, which isn't true.

**The client can never send refund values.** Any field in the body → 400 *"Cancellation takes
no fields: the refund is computed by the server"*. The refund is always calculated on the
server from the clinic clock.

| Status | When |
|---|---|
| 200 | cancelled: `{ data: { ...appointment, refundPercent, refundAmount, hoursNotice } }` |
| 400 | bad id, or any body field |
| 404 | unknown appointment |
| 422 | already cancelled ("already cancelled (on 2026-11-21 01:39:51)") or already started (appointment time ≤ now) |
| 405 | any other method (`Allow: PATCH`) |

**Already cancelled → 422, not 409:** the request is well-formed and the resource exists, but the
business rule "you can only cancel a BOOKED appointment" says no. Retrying would never succeed,
which is what separates it from a 409 conflict like "slot taken".

### The refund rule (`src/utils/refund.js`, pure)

`calculateRefund(amountPaid, appointmentDate, now)`. `now` is passed in, so tests use fixed dates.
Notice = appointment time − now, in **exact milliseconds**.

| Notice | Refund | Example (paid 100.00) |
|---|---|---|
| more than 48h (even 48h + 1 min) | 100% | 100.00 |
| **exactly 48h** | **50%** | 50.00 |
| 36h | 50% | 50.00 |
| **exactly 24h** | **50%** | 50.00 |
| 23h 59m | 0% | 0.00 |
| 0 or negative | (the API refuses: 422 "already started") | |

**Why these boundaries:** the README says "*more than* 48 hours → 100%; 24–48 hours → 50%; *less
than* 24 hours → 0%". "More than 48" excludes exactly 48, and "less than 24" excludes exactly 24,
so both exact boundaries fall into the 24–48 band (inclusive at both ends). The numbers come
from `REFUND_POLICY` in constants.

`hoursNotice` in the response is rounded to 2 decimals **for display only**. The tier is decided
on exact milliseconds: 47h 59m 59s shows as 48 but correctly gets 50%.

**Money in integer cents:** `refundCents = Math.round(toCents(amountPaid) × percent / 100)`. For
positive values `Math.round` rounds half up, which is exactly what MySQL's `ROUND(x, 2)` does on
DECIMAL. So the database CHECK `chk_appt_refund_matches_percent` (`refund_amount =
ROUND(amount_paid × refund_percent / 100, 2)`) always agrees: 99.99 × 50% = 49.995 → **50.00**,
120.01 × 50% = 60.005 → **60.01**. Floating-point noise can never decide a cent.

### The transaction (`appointmentModel.cancelAppointment`)

1. READ COMMITTED; `SELECT ... FROM appointments WHERE id = ? FOR UPDATE` locks that row.
2. **Re-check the status under the lock.** If two cancel requests for the same appointment
   arrive together, the second one waits at step 1, then sees CANCELLED → 422. The refund can
   never be paid twice.
3. Compare the appointment time with `clinicNow()` (passed as a parameter, never `NOW()`).
4. Compute the refund (pure function).
5. **ONE statement** writes all four columns together:
   `UPDATE appointments SET status = ?, cancelled_at = ?, refund_percent = ?, refund_amount = ?
   WHERE id = ? AND status = ?`. That's how "the cancellation and its refund record succeed or
   fail together" is met: one statement inside one transaction, backed by
   `chk_appt_status_consistency`, which rejects a half-cancelled row. If the UPDATE didn't change
   exactly 1 row, it throws and everything is rolled back.
6. COMMIT, then return the fresh row.

**The slot frees itself:** the generated column `active_slot` becomes NULL when the status becomes
CANCELLED, so `uq_appt_doctor_active_slot` no longer blocks that time. Another patient can book
it immediately, while the cancelled record stays for refund history (proven live:
cancel → rebook the same slot → 201).

**After COMMIT only:** `bookingEvents.onAppointmentCancelled(appointment, { source, hoursNotice })`
writes the `APPOINTMENT_CANCELLED` audit line and queues the "slot-freed" job for the waitlist
worker. Neither step can throw, so a logging or Redis problem can never turn a committed
cancellation into a 500.

---

## 13. Audit log with the `fs` module (Phase 7)

`src/services/auditLogger.js` → `log(event, payload)` appends one JSON line per event to
`logs/audit.log` (`LOG_DIR` from `.env`, default `logs`, relative to the project root).

```json
{"timestamp":"2026-11-20T23:39:51.460Z","event":"APPOINTMENT_CANCELLED","appointmentId":17,"apptRef":"AP-20261124-DP7R","patientId":1,"doctorId":2,"appointmentDateTime":"2026-11-24 09:00","amountPaid":100,"refundPercent":100,"refundAmount":100,"hoursNotice":79.34,"source":"api"}
```

- **Async only, never `*Sync`:** `fs/promises` `mkdir` + `appendFile`. A `*Sync` call would freeze
  the whole server (every other request) while the disk works.
- **Creates `logs/` on first run:** `mkdir(dir, { recursive: true })` runs once and is memoized as
  a promise that concurrent callers share. If it fails, the memo is cleared so the next event
  retries.
- **One line = one `appendFile`** on a file opened in append mode (O_APPEND), so each small line
  is written whole at the end of the file. Concurrent events never interleave (unit-tested with
  20 parallel writes; 60 lines from a live run were all valid JSON).
- **A logging failure never fails the request:** everything is inside `try/catch`; a failure only
  prints one `console.error` line. `log()` never throws or rejects.
- **Except where the log line IS the job:** the worker's confirmation processor uses
  `logStrict()` (`log(event, payload, { strict: true })`), which prints the error and then
  rejects. The BullMQ job fails and is retried with backoff, so a confirmation is never marked
  "completed" while its `NOTIFICATION_SENT` line was lost. No HTTP request uses strict mode.
- **JSON Lines** format: each line is a complete JSON object, so the file can be appended to
  forever and read line by line (`jq`, a spreadsheet import, `JSON.parse` per line).
- **Two clocks, on purpose:** `timestamp` is the real UTC instant of the event (unambiguous for
  auditing). `appointmentDateTime` / `cancelledAt` are clinic wall-clock times (§4).
- **Events:** `APPOINTMENT_BOOKED`, `APPOINTMENT_CANCELLED`, `WAITLIST_JOINED`, `WAITLIST_PROMOTED`,
  `WAITLIST_PROMOTION_FAILED`, `NOTIFICATION_SENT` (names in `AUDIT_EVENT`).
- **Testable:** `createAuditLogger({ dir, fs })` lets the tests use a temp folder and a fake `fs`
  that fails. The shared instance is created on first use, so `LOG_DIR` is read after `.env`
  has loaded.
- `logs/` is gitignored: it's runtime data, not source code.

---

## 14. Queues, Redis waitlist and the worker (Phase 8)

### Two tools, two jobs

| | BullMQ queues | Plain Redis lists |
|---|---|---|
| Used for | **jobs**: `slot-freed`, `send-confirmation` | **the waitlist** itself |
| Why | jobs need retries with backoff, and failed jobs kept for inspection; BullMQ gives that for free | the waitlist is *data* people look at (`GET /api/doctors/:id/waitlist`) and it must be strictly FIFO; a list is exactly that |

Job options: `attempts: 5`, exponential backoff from 2 s, `removeOnFail: false` (failed jobs stay
visible), and the last 1000 completed jobs are kept.

### Waitlist keys and order

```
waitlist:doctor:2:slot:2027-08-02T10:00   waiting for that exact slot
waitlist:doctor:2:day:2027-08-03          waiting for ANY slot that day (the day was full)
<list key>:processing                     the entry being promoted right now
waitlist:failed                           permanent failures, with the reason
```
Entry: `{ patientId, doctorId, requestedDateTime, type, joinedAt }`.
- **Join:** `RPUSH` (to the end). **Promote:** `LMOVE ... LEFT` (from the front). First come, first
  served.
- **Which list:** a 409 "slot taken" offers the *slot* list; a 409 "day full" offers the *day* list.
  When a slot frees up, the worker serves the exact-slot list first, then the day list.
- **No duplicates:** a small Lua script checks the list *and* its processing list for the patient
  and only then `RPUSH`es. Because it runs atomically inside Redis, two simultaneous joins can't
  both get in → 409 "already on the slot waitlist".
- **No pointless joins:** a patient who already holds a BOOKED appointment at that time can't
  wait for it → 409 (the promotion could never succeed).
- `GET /api/doctors/:id/waitlist` finds the doctor's lists with `SCAN` (never `KEYS`, which blocks
  Redis) and shows slot lists, day lists, processing and failed entries with positions.

### The worker: a separate process (`npm run worker`)

The web server only *produces* jobs; `src/workers/worker.js` *consumes* them. The server never
imports the worker, so slow background work can never slow down an HTTP request, and either
process can restart without the other.

**Promotion (slot-freed job), step by step:**
1. If the freed slot is no longer bookable (e.g. now in the past), its slot-list entries move to
   `waitlist:failed` with that reason.
2. `LMOVE waitlist processing LEFT RIGHT`: the oldest patient moves **atomically** into the
   processing list. This is the *reliable pop* pattern: at every moment the patient is in exactly
   one Redis list, so a crash can't make them disappear.
3. Book with the **same** `appointmentModel.bookAppointment(buildBookingRequest(...))` the API
   uses: same transaction, doctor lock, daily cap, unique indexes and outcomes.
4. Act on the outcome:

| Result | Class | What happens to the entry |
|---|---|---|
| BOOKED | success | removed from processing **only now, after COMMIT**; audit `WAITLIST_PROMOTED`; confirmation job queued |
| patient/doctor deleted, patient already booked at that time, amount above fee, unreadable entry | **PERMANENT** | moved to `waitlist:failed` with the reason + audit `WAITLIST_PROMOTION_FAILED {permanent: true}`; **try the next patient** |
| SLOT_TAKEN / DAY_FULL | **slot gone** | someone else took the slot first: not this patient's fault, so they go **back to the front** of their list; no retry (the slot is gone) |
| thrown error (DB/Redis down…) | **TRANSIENT** | back to the **front** of their list + audit `{permanent: false}`; the job is rethrown so BullMQ **retries with backoff** |

So a patient is **never lost from both Redis and MySQL**: they're either still waiting, being
processed, booked (MySQL), or in `waitlist:failed` with a reason. And nobody loops forever:
permanent failures leave the list, and transient ones are retried a bounded 5 times.

**Proven live:** B and C waited for a slot; B then booked the same time with another doctor;
cancelling freed the slot. The worker moved B to `waitlist:failed` ("patient already has another
appointment at that time") and booked C within a second.

**Concurrency 1** for `slot-freed`: two promotions never race for the same freed slot. The doctor
lock and unique index would still protect the data; this just avoids pointless conflicts.

**Start-up recovery:** before taking jobs, the worker moves everything left in `:processing` lists
(a crash between LMOVE and the final LREM) back to the **front** of its waitlist, oldest first.

**Waitlist sweep** (`src/workers/waitlistSweep.js`, at start-up and then every
`WAITLIST_SWEEP_INTERVAL_MS` = 60 s, never two runs at once): for every non-empty waitlist whose
slot (or day) actually has room, it re-queues a slot-freed job. This recovers promotions whose job
was lost while Redis was down, without restarting the worker. A wrong guess is harmless (the
patient just goes back to the front).

**Confirmation job:** writes `NOTIFICATION_SENT` with a simulated SMS, e.g. *"SMS to patient 1 (Ama
Mensah): Your appointment AP-20261124-DP7R with Dr. Efua Adjei is confirmed for 2026-11-24 09:00.
Amount paid: 100.00."* Every confirmed appointment (API or promotion) queues one. The line is
written with `logStrict()`, so if it can't be written the job fails and is retried (§13).

**Graceful shutdown** (Ctrl+C / SIGTERM): close the BullMQ workers (running jobs finish first),
then the Redis connections, the producer queues and the MySQL pool.

### Redis down: the trade-off

- **MySQL is the source of truth**, so booking (201) and cancelling (200) **still succeed**. The
  confirmation / slot-freed job just isn't queued, and the server prints one warning.
- **Joining or reading the waitlist → 503** "The waitlist is temporarily unavailable (Redis is
  down)": the waitlist lives in Redis, so honesty beats pretending.
- The server's Redis client **fails fast** (`enableOfflineQueue: false`, one retry, 2 s command
  timeout, at most 1.5 s wait on first connect), so an HTTP request can never hang on Redis.
- **Trade-off:** a slot-freed job lost while Redis was down means no *immediate* promotion for
  that slot. It's recovered by the worker's **waitlist sweep** within one sweep interval (60 s)
  after Redis is back, with no restart needed. A confirmation SMS that could not even be queued
  while Redis was down is not re-sent.
- The worker's own connections wait and reconnect (BullMQ requires `maxRetriesPerRequest: null`),
  so it resumes by itself when Redis comes back.

---

## 15. Statistics and reports (Phase 9): advanced SQL

All figures are computed **by SQL in the models** (`statisticsModel.js`, `reportModel.js`). JS only
renames columns. The README assesses this ("not fetched raw and computed in JavaScript"): the
database aggregates next to the data and its index, and the numbers can't drift from what's
stored. Every date is computed in Node and passed as `?`, and the rule numbers (`DAILY_CAP`,
`BUSY_THRESHOLD`, `STATS_WINDOW_DAYS`) are passed as parameters, never typed into the SQL.

### `GET /api/doctors/:id/statistics?from=YYYY-MM-DD`

Definitions:
- **revenueCollected** = `SUM(amount_paid − COALESCE(refund_amount, 0))` over all the doctor's
  appointments (lifetime). A BOOKED row adds what was paid; a CANCELLED row adds what was *kept*
  after the refund (0 after a 100% refund). This is money actually collected.
- **upcomingAppointments** = BOOKED with `appt_datetime > now` (clinic now), independent of `from`.
- **Window** = the 7 days starting at `from` (default: clinic today), `[from 00:00, from+7 00:00)`.
  `?from` exists because the seed's appointments are in March 2027: `?from=2027-03-15` shows the
  busy week.
- **utilization** = booked in the window ÷ (`DAILY_CAP` × 7) × 100, rounded to 1 decimal in SQL.

**Query 1: summary (one row)** (outer column list shortened here; the full text is in
`src/models/statisticsModel.js`, `findDoctorSummary`):
```sql
SELECT s.*, ROUND(s.booked_in_window / s.capacity_in_window * 100, 1) AS utilization_percent
  FROM (SELECT d.id, d.full_name,
               COALESCE(SUM(a.amount_paid - COALESCE(a.refund_amount, 0)), 0)            AS revenue_collected,
               COUNT(CASE WHEN a.status = ? AND a.appt_datetime > ? THEN 1 END)           AS upcoming_appointments,
               COUNT(CASE WHEN a.status = ? AND a.appt_datetime >= ? AND a.appt_datetime < ? THEN 1 END) AS booked_in_window,
               ? * ?                                                                      AS capacity_in_window
          FROM doctors d LEFT JOIN appointments a ON a.doctor_id = d.id
         WHERE d.id = ?
         GROUP BY d.id, d.full_name) AS s
```
Line by line:
- `FROM doctors d LEFT JOIN appointments a`: start from the **doctor**, so a doctor with no
  appointments still gives one row (with NULL `a.*`), and an unknown id gives **no** row → 404.
- `WHERE d.id = ?` / `GROUP BY d.id, d.full_name`: one doctor, one row.
- `COALESCE(SUM(amount_paid − COALESCE(refund_amount, 0)), 0)`: the inner COALESCE treats "no
  refund" as 0; the outer one turns the NULL sum of a doctor with no appointments into 0.
- `COUNT(CASE WHEN … THEN 1 END)`: **conditional aggregation**. The CASE yields 1 for rows that
  match and NULL otherwise, and COUNT ignores NULLs. Several different counts come from **one
  pass** over the rows.
- `? * ?` = `DAILY_CAP × STATS_WINDOW_DAYS` = 84 slots of capacity.
- The outer `SELECT ... ROUND(... * 100, 1)` reuses the two aggregates without repeating them.

**Query 2: one row per day, including days with zero bookings (recursive CTE):**
```sql
WITH RECURSIVE window_days (cal_date, n) AS (
        SELECT CAST(? AS DATE), 1
        UNION ALL
        SELECT cal_date + INTERVAL 1 DAY, n + 1 FROM window_days WHERE n < ?
      )
SELECT w.cal_date, COUNT(a.id) AS booked, ROUND(COUNT(a.id) / ? * 100, 1) AS utilization_percent
  FROM window_days w
  LEFT JOIN appointments a
         ON a.doctor_id = ? AND a.status = ?
        AND a.appt_datetime >= w.cal_date AND a.appt_datetime < w.cal_date + INTERVAL 1 DAY
 GROUP BY w.cal_date
 ORDER BY w.cal_date
```
Line by line:
- **The problem:** `GROUP BY DATE(appt_datetime)` only returns days that *have* appointments, so
  empty days would be missing.
- `WITH RECURSIVE`: the anchor `SELECT CAST(? AS DATE), 1` is day 1 (`from`). The recursive part
  adds one day until `n` reaches 7. Result: a 7-row calendar. `CAST(? AS DATE)` fixes the column
  type (in a recursive CTE the anchor decides the type).
- `LEFT JOIN appointments`: hangs each day's bookings on the calendar, and keeps days with none.
  The doctor/status filters are in `ON`, not `WHERE`, because a WHERE on `a.*` would throw away
  the empty days and turn it back into an inner join.
- `>= cal_date AND < cal_date + INTERVAL 1 DAY`: a **sargable** half-open range, so
  `idx_appt_doctor_datetime` is used (`DATE(appt_datetime) = cal_date` would defeat the index).
- `COUNT(a.id)`, not `COUNT(*)`: an empty day has one row with NULL `a.id` → 0.
  `COUNT(*)` would say 1.

Live result (doctor 1, `?from=2027-03-15`): revenue **1620**, upcoming **11**, per day
**11, 0, 0, 0, 0, 0, 0**, utilization **11 / 84 = 13.1%**. Doctor 3: revenue 0, upcoming 0, seven
zero days.

### `GET /api/reports/doctors`: every doctor, including those with zero appointments
```sql
SELECT d.id, d.full_name, d.specialty,
       COUNT(a.id)                                                     AS total_appointments,
       COUNT(CASE WHEN a.status = ? THEN 1 END)                        AS booked_appointments,
       COUNT(CASE WHEN a.status = ? THEN 1 END)                        AS cancelled_appointments,
       COALESCE(SUM(a.amount_paid - COALESCE(a.refund_amount, 0)), 0)  AS revenue_collected,
       COALESCE(SUM(a.refund_amount), 0)                               AS total_refunded
  FROM doctors d
  LEFT JOIN appointments a ON a.doctor_id = d.id
 GROUP BY d.id, d.full_name, d.specialty
 ORDER BY revenue_collected DESC, d.id
```
- **`LEFT JOIN`** (not `JOIN`) is what makes Dr. Owusu-Ansah, who has no appointments, appear. An
  inner join would drop him.
- `COUNT(a.id)` → 0 for him; `COALESCE(SUM(...), 0)` → 0 instead of NULL.
- Every non-aggregated column is in `GROUP BY` (MySQL's ONLY_FULL_GROUP_BY mode).
- Ordered by revenue (top earner first), with id as a stable tie-breaker.
- Live: Boateng 13 appointments / **1620**, Adjei 3 / **300**, Owusu-Ansah 0 / **0** (matches §9).

### `GET /api/reports/busy-days`: more than 80% of the 12-slot cap
```sql
SELECT d.id, d.full_name, DATE(a.appt_datetime) AS appt_date, COUNT(*) AS booked,
       ROUND(COUNT(*) / ? * 100, 1) AS capacity_percent
  FROM appointments a
  JOIN doctors d ON d.id = a.doctor_id
 WHERE a.status = ?
 GROUP BY d.id, d.full_name, DATE(a.appt_datetime)
HAVING COUNT(*) > ? * ?
 ORDER BY appt_date, d.id
```
- `WHERE a.status = ?` (BOOKED): cancelled rows don't use capacity.
- `GROUP BY doctor, DATE(...)`: one group per doctor-day.
- **`HAVING`, not `WHERE`:** WHERE filters rows *before* grouping and can't see `COUNT(*)`; HAVING
  filters the *groups* after counting.
- `> ? * ?` = `> BUSY_THRESHOLD × DAILY_CAP` = `> 0.8 × 12` = `> 9.6`, i.e. 10 or more. Both numbers are
  parameters from constants.
- `ROUND(COUNT(*) / ? * 100, 1)` = % of capacity.
- Live: exactly one row: Dr. Boateng, 2027-03-15, 11 booked, **91.7%**.

---

## 16. i18n and l10n: `GET /feedback` (Phase 10)

- **Locale files** `locales/en.json` and `locales/fr.json` have **identical keys** (title, heading,
  instructions, dateLabel, the 5 questions, submit label, …). The English questions are the README's
  text word for word (a unit test enforces it), and the French ones are translations.
- **Loaded once at start-up, asynchronously:** `loadLocales()` (`fs/promises`) starts when the
  feedback controller is first required and checks every file (all keys present, exactly 5
  questions). Each request awaits that same, already-finished promise, so there's no file I/O per
  request and no `*Sync`. A broken locale file is reported at start-up and `/feedback` answers 500.
- **Language choice:** `?lang=fr` → French. Missing, unsupported (`xx`), repeated
  (`?lang=fr&lang=en` → an array) or non-string values → English (`I18N.DEFAULT_LANGUAGE`), never a
  crash. `FR` and ` fr ` are accepted (trimmed and lower-cased). `<html lang="en|fr">` and a
  `Content-Language` header are set.
- **Localized date:** `Intl.DateTimeFormat('en-GB' | 'fr-FR', { dateStyle: 'full', timeZone:
  CLINIC_TIMEZONE })` → *"Saturday, 21 November 2026"* / *"samedi 21 novembre 2026"*. It formats the
  real instant in the **clinic's** time zone, so the page shows the clinic's date even near midnight
  or on a server in another zone. en-GB (day-month) suits an African clinic better than en-US.
- **Escaping:** `renderFeedbackPage()` is a pure function. Every inserted value goes through
  `escapeHtml` (`& < > " '`), so translated text can never inject HTML or script. Unit-tested with a
  malicious title.
- **The form:** exactly 5 `<label>` + `<textarea required>` pairs and a submit button. It submits
  with GET back to the page (keeping the language). Answers aren't stored, since the brief asks for
  a simple page, and the page says so.
