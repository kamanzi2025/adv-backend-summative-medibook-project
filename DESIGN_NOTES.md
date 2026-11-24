# MediBook: Design Notes

These notes explain the decisions behind the project and the reasons for them, in roughly the
order I'd walk through them in the video.

---

## 1. Project layout, and why it's split this way

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

`app.js` and `server.js` are separate because building the app and starting it are two different
jobs. `app.js` only builds it, so a test or a script can import the app without opening a port or
a database connection. `server.js` is what actually starts listening.

The files in `utils/` have to stay pure, because the brief says the tests must run without MySQL
or Redis. If `utils/refund.js` imported `config/db.js`, just loading it in a test would try to
connect. So the pure utils import nothing except `config/constants.js`, which doesn't do any I/O
either.

The SQL rule is simple: only files in `src/models/` import `config/db.js`. Even the one-line health
check (`SELECT 1`) is in `models/healthModel.js`, and the controller calls it. That makes the rule
easy to check with a single search.

---

## 2. Configuration and secrets

The real values live in `.env`, which git ignores. `.env.example` is committed and only has
placeholders (`change_me_...`). The `.gitignore` ignores `.env` and `.env.*`, then adds
`.env.example` back.

`config/env.js` is the only file that reads `process.env` for the connection settings. It runs
`dotenv` once and stops straight away with a clear message if something required, like `DB_USER`,
is missing. Otherwise you'd only find out later from a confusing MySQL error.

`config/constants.js` is the one place for every business number: the working hours
(`09:00`–`17:00`), `SLOT_MINUTES = 30`, `DAILY_CAP = 12`, `BUSY_THRESHOLD = 0.8`, the refund tiers
and the 7-day statistics window. Changing a rule means changing one line. The objects are frozen
with `Object.freeze`, so no code can change a rule by accident while the app is running.

---

## 3. Infrastructure: MySQL installed locally, Redis in Docker

MySQL 8 runs as the normal Windows service `MySQL80` on port 3306. Redis 7 runs in Docker from
`docker-compose.yml`, which only contains Redis.

I split it like this for two reasons. MySQL was already installed and running, and a second MySQL
in Docker would have duplicated it and fought over port 3306. Redis, on the other hand, has no
official Windows build, and Docker is the simplest supported way to get a real Redis 7 on Windows.
I need at least Redis 6.2 for `LMOVE`.

### MySQL

The app connects as `medibook_user`, not root. That user only has `SELECT, INSERT, UPDATE, DELETE`
on `medibook.*`, because that's all the code needs. So even a bug or a leaked `.env` can't drop
tables, change the schema, create users or read other databases.

The schema scripts are run by hand as root (or another account that can create databases), because
`schema.sql` starts with `DROP DATABASE IF EXISTS medibook; CREATE DATABASE medibook;`. Dropping and
recreating the database doesn't break `medibook_user`. MySQL keeps grants by database name
(`GRANT ... ON medibook.*`) in its own system tables, not inside the database, so the grant applies
again as soon as `medibook` exists.

### Redis

The port is bound to `127.0.0.1`, so only this PC can reach Redis, not the rest of the network.
That's why no password is needed locally; `REDIS_PASSWORD` is there for other environments.
`--appendonly yes` writes every change to disk, so the waitlist survives a Redis or Docker restart.
`restart: unless-stopped` and a named volume keep Redis and its data across reboots, and a health
check (`redis-cli ping`) makes `docker compose ps` show `healthy`.

---

## 4. Time zones: the "clinic clock"

The clinic runs on Africa/Johannesburg time (UTC+2), but a database server's clock and time zone are
set up separately from the app. MySQL might be set to UTC, or the app might run on a machine in a
different zone. If some code used MySQL's `NOW()` and other code used Node's clock, questions like
"is this slot in the future?" or "how many upcoming appointments?" could disagree by hours.

So here's what I decided:

1. Every appointment time is a clinic wall-clock time, meaning what the receptionist sees on the
   wall. It's sent as `"YYYY-MM-DD HH:mm"` and stored in a plain `DATETIME`, which has no time zone.
2. No query in the app uses `NOW()`, `CURDATE()` or `CURRENT_TIMESTAMP`. "Now" and "today" are worked
   out once in Node by `clinicNow()` in `src/utils/clock.js` and passed into the SQL as `?`
   parameters. That way validation, statistics, upcoming counts and the 7-day window all use the
   same clock.
3. `clinicNow()` uses `Intl.DateTimeFormat` with `CLINIC_TIMEZONE` (read by `src/config/settings.js`),
   so it gives the right answer whatever time zone the PC or container is set to.
4. Inside the code, a "clinic Date" is a JS `Date` whose UTC fields hold the clinic's wall-clock
   time, so 09:00 in Johannesburg is held as `09:00Z`. All the date math (hours of notice, adding
   days) uses the UTC fields. They have no daylight-saving jumps, so the host's time zone can never
   shift anything.
5. mysql2 is set to `dateStrings: true`, so DATETIME values come back as exactly the text that was
   stored, with no conversion by Node.
6. As a safety net, the Redis container gets `TZ=Africa/Johannesburg` (from `CLINIC_TIMEZONE`), so its
   logs show clinic time. MySQL's own time zone doesn't matter, because the app never asks MySQL
   what time it is.

`tests/clock.test.js` tests the conversion, including the case near midnight where it's still
"yesterday" in UTC but already "today" at the clinic.

---

## 5. Libraries

| Library | Why |
|---|---|
| `express@5` | The REST framework. Version 5 passes errors from `async` handlers to the error middleware by itself, so I don't need a try/catch wrapper in every controller. |
| `mysql2` (promise API) | The required driver. `?` placeholders send the values separately from the SQL text, which is what prevents SQL injection. `multipleStatements` stays `false`. |
| `dotenv@16` | Loads `.env`. |
| `ioredis` + `bullmq` | BullMQ handles the background jobs properly: retries with backoff, and failed jobs kept so I can look at them. I also use ioredis directly for the waitlist lists (`RPUSH`, `LMOVE`). |
| `jest` | Unit tests. |
| `nodemon` (dev only) | Restarts the server when a file changes (`npm run dev`). |

The Redis client behaves differently in the two processes (`config/redis.js`). In the web server
it's set to `enableOfflineQueue: false` and `maxRetriesPerRequest: 1`, so if Redis is down a command
fails immediately instead of leaving the HTTP request hanging. Booking and cancelling still work,
because MySQL is the source of truth; only the follow-up job fails, with a warning in the log. The
worker uses `maxRetriesPerRequest: null`, which BullMQ requires because its workers use blocking
commands that wait for jobs. Both keep reconnecting in the background with a growing delay (up to a
limit), and the "Redis is down" warning is printed once rather than on every retry.

---

## 6. Summary of the main decisions

This table lists the decisions I made at the start, with the section that explains each one.

| Topic | Decision | Section |
|---|---|---|
| Slots | 16 possible start times (09:00–16:30), at most 12 booked per doctor per day; cancelled rows don't count | §11 |
| Busy day | "More than 80% of 12" is more than 9.6, so 10 or more bookings. The cap and the threshold are passed into the SQL as parameters | §15 |
| amount_paid | Defaults to the doctor's fee. An optional `amountPaid` from 0 up to the fee is allowed, because the spreadsheet shows a discount (AP-002 paid 120 on a 150 fee) | §11 |
| Refund boundaries | More than 48h → 100%; 24h–48h inclusive → 50%; under 24h → 0%. Calculated in whole cents | §12 |
| Cancel endpoint | `PATCH /api/appointments/:id/cancel`. The record is kept, so `DELETE` would be misleading | §12 |
| Revenue | `SUM(amount_paid − COALESCE(refund_amount, 0))`: the money the clinic actually kept | §15 |
| Utilization | booked ÷ (12 × 7) over the same 7-day window | §15 |
| Deleting with history | Foreign keys are `ON DELETE RESTRICT` → 409, so refund history is never lost | §10 |
| Patient double booking | A patient can't hold two booked appointments at the same time, even with different doctors | §8, §11 |
| appt_ref | `AP-YYYYMMDD-XXXX`: the appointment date plus 4 random `0-9A-Z` characters. Made in Node before the insert and retried if it hits the `uq_appt_ref` index. No insert-then-update on a NOT NULL UNIQUE column | §11 |
| Waitlist | Redis lists per doctor and slot, and per doctor and day; first in, first out (`RPUSH` / `LMOVE … LEFT`); a processing list so a pop is never lost; temporary vs permanent failures; `waitlist:failed`; recovery at start-up; no duplicate joins; `GET /api/doctors/:id/waitlist` | §14 |
| Redis down | Booking and cancelling still work; joining the waitlist → 503. A lost "slot-freed" job is picked up by the worker's sweep (at start-up and every 60 s) | §14 |
| Feedback date format | `en-GB` and `fr-FR` | §16 |
| Statistics window | `GET /api/doctors/:id/statistics` takes an optional `?from=YYYY-MM-DD` (400 if it's malformed), defaulting to today from `clinicNow()`. The seed appointments are in March 2027, so the default "next 7 days" would be all zeros in a demo; `?from=2027-03-15` shows the busy week. The SQL still gets the window dates as `?` parameters | §15 |
| Showing the 50% and 0% refunds | The seeded cancellations can only be 100% (see §9), so `requests.http` books appointments for today and tomorrow through the API and then cancels them, which shows the 0% (under 24h) and 50% (24–48h) tiers | §12 |

---

## 7. Normalization: from the spreadsheet to 3NF

### What was wrong with the spreadsheet

| appt_ref | patient_name | patient_email | patient_phone | doctor_name | specialty | consultation_fee | room | … | amount_paid |
|---|---|---|---|---|---|---|---|---|---|
| AP-001 | Ama Mensah | ama@mail.com | 0244-111-222 | Dr. Boateng | Dermatology | 150.00 | R-12 | … | 150.00 |
| AP-002 | Kojo Owusu | kojo@mail.com | 0555-333-444 | Dr. Boateng | Dermatology | 150.00 | R-12 | … | 120.00 |
| AP-003 | Ama Mensah | ama@mail.com | 0244-111-222 | Dr. Adjei | Paediatrics | 100.00 | R-03 | … | 100.00 |

The first problem is redundancy. Ama's name, email and phone are typed again on every appointment
Ama makes, and Dr. Boateng's specialty, fee and room are repeated on every one of Dr. Boateng's
appointments. That leads to the three classic anomalies:

- **Update:** if Ama's phone number changes, every one of Ama's rows has to be changed. Miss one and
  the data contradicts itself.
- **Insert:** you can't record a new doctor until someone books with them, because there's no row
  to put them in. That's exactly the "doctor with zero appointments" case the reports have to show.
- **Delete:** deleting a patient's only appointment also deletes the only record of that patient,
  and possibly of a doctor too.

### How each normal form is met

**1NF** needs atomic values, no repeating groups and a key for each row. Every cell holds one value
(one phone, one datetime), there are no lists like "slot1, slot2", and every table has a primary
key, `id`.

**2NF** says nothing may depend on only part of a key. Every table uses a single-column surrogate
key (`id`), and you can only have a partial dependency with a composite key, so 2NF holds
automatically. Looking at the spreadsheet, `patient_email` depended on the patient, not on the whole
appointment, so the patient columns moved to `patients`. In the same way, the doctor columns moved
to `doctors`.

**3NF** says no non-key column may depend on another non-key column. In the spreadsheet,
`appt_ref → doctor_name → specialty, consultation_fee, room`: the fee depended on the doctor, not on
the appointment. So `specialty`, `consultation_fee` and `room` now live only in `doctors`, and
`appointments` just keeps `doctor_id`. Likewise `appt_ref → patient_email → patient_name,
patient_phone`, so those now live only in `patients`.

### Why `amount_paid` stays on `appointments`

AP-002 paid 120.00 on a 150.00 fee. That makes `amount_paid` a fact about that particular
appointment, meaning what was actually charged, maybe after a discount. It isn't a fact about the
doctor. The fee might also change next year, but what someone paid last year mustn't change with it.
A column is only redundant if it can be worked out from other columns, and `amount_paid` can't be.

### Why cancellations and refunds are columns, not tables

The brief allows exactly 3 tables. `status`, `cancelled_at`, `refund_percent` and `refund_amount`
each depend on the appointment's key and nothing else, so keeping them on `appointments` is still
3NF. A cancelled appointment has exactly one cancellation and one refund, so it's a one-to-one fact
about the row.

### Can't `refund_amount` be worked out from `refund_percent`?

Yes: `refund_amount = amount_paid × refund_percent / 100`. I store both anyway, because the amount is
the money that was actually paid back, which is the record finance would want. The CHECK
`chk_appt_refund_matches_percent` makes it impossible for the two to disagree, so the normal risk of
storing a derived value, that it gets out of step, is ruled out by the database itself.

### Candidate keys

`patients.email` is UNIQUE, which makes it a candidate key. `id` is still the primary key because
emails can change and are long to use as foreign keys. `doctors.room` is UNIQUE because each doctor
has their own consulting room. `appointments.appt_ref` is UNIQUE too; it's the readable reference
and another candidate key.

---

## 8. Schema decisions (`database/schema.sql`)

### Types

| Column(s) | Type | Why |
|---|---|---|
| ids | `INT UNSIGNED AUTO_INCREMENT` | never negative, and 4 billion rows is plenty |
| money (`consultation_fee`, `amount_paid`, `refund_amount`) | `DECIMAL(10,2)` | exact decimal math. `FLOAT` would store 0.1 as 0.1000000001 |
| `appt_datetime`, `booked_on`, `cancelled_at` | `DATETIME` | keeps the clinic wall-clock time exactly as given. `TIMESTAMP` would convert it through the session time zone (see §4) |
| `status` | `ENUM('BOOKED','CANCELLED')` | only two legal values, enforced by MySQL, in 1 byte |
| `refund_percent` | `TINYINT UNSIGNED` | 0–100 fits in 1 byte |
| `email` | `VARCHAR(254)` | the longest email address the SMTP standard allows |
| `appt_ref` | `VARCHAR(16)` | `AP-` + 8-digit date + `-` + 4 characters = 16 |

The character set is `utf8mb4` with `utf8mb4_0900_ai_ci`, so any name can be stored, with accents or
in any script. Because the collation is `_ci` (case-insensitive), `AMA@mail.com` and `ama@mail.com`
also count as the same email for `uq_patient_email`.

### The slot rule: a generated column and a UNIQUE index

```sql
active_slot DATETIME GENERATED ALWAYS AS
  (CASE WHEN status = 'BOOKED' THEN appt_datetime ELSE NULL END) STORED,
CONSTRAINT uq_appt_doctor_active_slot UNIQUE (doctor_id, active_slot)
```

A plain `UNIQUE(doctor_id, appt_datetime)` doesn't work here. Once anyone had booked a slot it
would be blocked forever, even after they cancelled, because the cancelled row is kept for refund
history. And deleting the cancelled row would lose that history.

So MySQL works out `active_slot` itself. It equals the slot time while the appointment is BOOKED and
becomes NULL the moment it's CANCELLED. A UNIQUE index treats every NULL as different from every
other NULL. That means two booked rows for the same doctor and time have the same `active_slot` and
the second one fails with ERROR 1062, while any number of cancelled rows for that time are all NULL
and are allowed.

I made it STORED rather than VIRTUAL so the value is written to disk and indexed like a normal
column, and the UNIQUE check is a plain index lookup.

This is also the final guarantee when requests arrive at the same time. Even if two requests pass
every check in Node at the same instant, InnoDB only lets one of them insert that index key. The
other gets ERROR 1062, which the API turns into 409 Conflict (§11). The same trick gives
`uq_appt_patient_active_slot`, so a patient can't be in two places at once.

### CHECK constraints: the database's own last line of defense

MySQL 8.0.16 and later actually enforce CHECK constraints; older versions read them and then ignored
them. The API validates everything first and gives friendly 400 and 422 messages. The CHECKs are
there so that nothing else, whether a bug, a manual SQL edit or some future script, can store a row
that makes no sense.

- **Slot shape:** `chk_appt_slot_minutes`, `chk_appt_slot_seconds` and `chk_appt_working_hours`. The
  values `'09:00:00'`, `'16:30:00'` and `(0, 30)` are deliberately the same as `WORKING_HOURS_START`,
  `WORKING_HOURS_END − SLOT_MINUTES` and `SLOT_MINUTES` in `src/config/constants.js`. SQL can't read
  JS constants, so if the clinic's hours ever change, both places need updating.
- **"Future only" isn't a CHECK** because MySQL doesn't allow functions like `NOW()` in a CHECK; the
  answer would change over time. So the booking code enforces "in the future" using `clinicNow()`.
  The part that doesn't depend on the time is still checked: `chk_appt_booked_before_slot`
  (`booked_on < appt_datetime`).
- **"At most 12 a day" isn't a CHECK** because a CHECK only sees the row being written; it can't
  count other rows. The booking transaction enforces it (§11).
- **"amount_paid ≤ fee" isn't a CHECK** because a CHECK can't read another table (`doctors`). The
  booking code enforces it.
- **Status consistency** (`chk_appt_status_consistency`): a booked row can't have a refund, and a
  cancelled row must have `cancelled_at`, `refund_percent` and `refund_amount` all together. This
  backs up the brief's rule that the cancellation and its refund record succeed or fail together.
  The database simply can't hold a half-cancelled row.
- **How NULL behaves:** a CHECK only fails when its expression is FALSE, and NULL counts as passing.
  So `chk_appt_refund_within_paid` (`refund_amount BETWEEN 0 AND amount_paid`) lets booked rows
  through automatically, since their refund is NULL.

### Foreign keys: `ON DELETE RESTRICT`

`fk_appt_patient` and `fk_appt_doctor` use RESTRICT, so MySQL refuses to delete a patient or doctor
who has appointments, even cancelled ones. Refund history must never disappear or point at nothing.
The API reports it as 409 Conflict (§10). `ON DELETE CASCADE` would quietly delete financial
history, and `SET NULL` wouldn't even be possible, because the foreign key columns are NOT NULL:
every appointment needs a patient and a doctor.

### Constraint names

Every constraint has a name with a prefix (`pk_`, `uq_`, `chk_`, `fk_`, `idx_`), so the error
messages, the diagram, the SQL and the video all use the same words. MySQL's error says
`Duplicate entry ... for key 'appointments.uq_appt_doctor_active_slot'`, for example, and the API
code can tell from the name which rule fired. (MySQL always calls the primary key index `PRIMARY`;
the `pk_` names are there to make the script and diagram clearer.)

### Index

`idx_appt_doctor_datetime (doctor_id, appt_datetime)` speeds up "how many booked appointments does
doctor X have on day Y", which runs on every booking and in every report. The foreign key columns
are already indexed by the two UNIQUE indexes, since both start with the foreign key column, and
InnoDB needs that for foreign keys.

### `schema.sql` resets the database

It starts with `DROP DATABASE IF EXISTS medibook; CREATE DATABASE medibook; USE medibook;`, so it
always gives a clean, known starting point. That's why it has to be run as root (or another account
that can create databases). `medibook_user` keeps working afterwards because grants are stored by
database name (§3).

---

## 9. Seed data (`database/seed.sql`)

| What the rubric asks for | Where it is in the seed |
|---|---|
| At least 3 patients | 11 patients (ids 1–11). Ama and Kojo use the spreadsheet's emails |
| At least 3 doctors, one with no appointments | Dr. Boateng (1), Dr. Adjei (2), and Dr. Owusu-Ansah (3) with none |
| At least 8 appointments | 16 (14 booked, 2 cancelled) |
| A doctor-day at or near the cap of 12 | Dr. Boateng on 2027-03-15 has 11 booked (09:00–14:00), which is 91.7%, over 80%, so it's in the busy-days report. A 12th booking works and a 13th is refused |
| A cancellation with a refund that follows the policy | Appointment 12 (150.00 → 100% = 150.00) and 16 (120.00 → 100% = 120.00), both cancelled months ahead, so more than 48h notice and 100% back |
| The AP-002 discount | Appointment 2: Kojo paid 120.00 on a 150.00 fee (appointment 16 too) |
| A cancelled slot can be booked again | Appointment 12 (cancelled) and appointment 1 (booked) are in the same slot, Dr. Boateng 2027-03-15 09:00 |

The ids are set by hand so the demo requests (`/api/doctors/1`, `/api/appointments/12`) are
predictable, and the rows go in an order the foreign keys allow: patients, doctors, appointments.
Everything runs in one transaction (`START TRANSACTION … COMMIT`), so if any row breaks a constraint
nothing is half-loaded.

The appointment dates are in 2027 so they're in the future and can be cancelled or rebooked during
the demo. `booked_on` and `cancelled_at` are in November 2026, in the past, because they record
things that already happened; a booking can't have been made in the future.

That's also why the seed only has 100% refunds. A 50% or 0% refund needs a cancellation less than
48 hours before the appointment. With appointments in 2027 and cancellations in the past, that's
impossible without inventing future events. Instead, the 50% and 0% tiers are shown live through the
API (book an appointment for today or tomorrow, then cancel it) and in the unit tests.

The expected report numbers, which are handy in the video, are: Dr. Boateng's revenue is
10 × 150 + 120 = 1620.00 (the cancelled ones were fully refunded, so they add nothing), Dr. Adjei's
is 3 × 100 = 300.00, and Dr. Owusu-Ansah's is 0.00.

`database/verify.sql` is a demo script that shows the constraints working. It tries the forbidden
inserts inside a transaction and then rolls back, so no rows change. Two things are worth knowing
when you demo it. First, run it through stdin with `--force`:
``cmd /c "`"$mysql`" -u medibook_user -p --table --force medibook < database\verify.sql"``
(where `$mysql` is the full path to `mysql.exe`, as in the README), because the client's `source`
command stops at the first error even with `--force`. Second, afterwards the next appointment id is
21, not 17. InnoDB hands out an AUTO_INCREMENT value to every attempted insert and doesn't give it
back after an error or a ROLLBACK. Gaps in the ids are normal and harmless, which is one reason the
reference people actually see is `appt_ref`, not `id`.

---

## 10. REST API design: patients and doctors

### Endpoints

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/patients?limit=&offset=` | 200 `{ data: [...], meta: { limit, offset, total } }` | 400 bad pagination |
| POST | `/api/patients` | 201 + `Location: /api/patients/{id}` + `{ data }` | 400, 409 duplicate email |
| GET | `/api/patients/:id` | 200 `{ data }` | 400 bad id, 404 |
| PATCH | `/api/patients/:id` | 200 `{ data }` (the updated row) | 400, 404, 409 duplicate email |
| DELETE | `/api/patients/:id` | 204 (no body) | 400, 404, 409 has appointments |
| … | `/api/doctors` and `/api/doctors/:id` | same pattern | 409 duplicate room / has appointments |

### Why I made these REST choices

Collections are plural nouns and single items use their id (`/api/patients`, `/api/patients/7`).
The HTTP method says what happens, so there are no verbs in the URLs like `/getPatient` or
`/deletePatient`. Everything JSON sits under `/api`, which keeps it apart from the HTML feedback
page at `GET /feedback` (§16).

Updates use PATCH, not PUT. PUT means "replace the whole resource": the client would have to send
every field again just to change a phone number, and a missing field could reasonably mean "erase
it". PATCH means "change just these fields", which is what a receptionist actually does. The rules
are: any of the fields, at least one, no unknown fields, and no `null`, because every column is NOT
NULL.

PUT and any other unsupported method get 405 Method Not Allowed with an `Allow` header, for example
`Allow: GET, PATCH, DELETE`, rather than 404. The URL does exist; only the method is wrong. URLs
that don't exist at all get 404.

Creating something returns 201 with a `Location` header, which is the standard way to tell the
client where the new resource is. Deleting returns 204 No Content, since the resource is gone and
there's nothing to send back, and that's the same for patients and doctors.

Every successful body is `{ data: ... }`, lists also get `meta`, and every error is `{ error: ... }`.
A client can tell success from failure just from the top-level key, and adding pagination details
later never changes the shape.

The JSON is camelCase and the SQL is snake_case, following the usual convention on each side. The
model translates between them (`toPatient(row)`), so the controllers never see column names.

For pagination, `limit` defaults to 20 with a maximum of 100 (`PAGINATION` in constants), and
`offset` defaults to 0. Without a maximum, `?limit=100000000` could make the server load a whole
table into memory. `meta.total` lets a client show something like "page 2 of 6".

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
| 422 | well-formed but breaks a business rule | booking in the past, at 09:15, cancelling twice |
| 500 | a bug; the details are hidden from the client and logged on the server | |
| 503 | MySQL unreachable or rejecting the login | "The database is temporarily unavailable" |

The difference between 400 and 422 is this. 400 means "I can't even understand this request": the
syntax, types or shape are wrong. 422 means "I understand it, but the rules say no." `/api/patients/abc`
is a 400 because `abc` isn't an id at all. Booking at 09:15 is a 422 because it's a real,
well-formed time that the clinic's rules don't allow.

Likewise, `/api/patients/abc` is 400 but `/api/patients/9999` is 404. `abc` can never be an id, so
it's bad input. 9999 could be an id; there just isn't one yet.

### Validation (`src/validators/`)

The validators are pure functions, so they can be unit-tested without a database.
`validateBody(body, rules, { partial })` checks a body against a set of field rules and collects
every problem before failing, so the client sees all of them in one response:

```json
{ "error": { "status": 400, "message": "Invalid patient: check fullName, email, phone",
    "details": [ { "field": "fullName", "message": "is required" },
                 { "field": "email", "message": "must be a valid email address, e.g. name@example.com" },
                 { "field": "phone", "message": "is required" } ] } }
```

Strings are trimmed before they're checked, so `"   "` counts as blank and `" Ama "` is stored as
`"Ama"`. The maximum lengths come from `FIELD_LIMITS` in constants, which match the column sizes
(`VARCHAR(100)` and so on). Length is counted in characters (`[...text].length`), the same way as
MySQL's `CHAR_LENGTH`, so an emoji counts as one.

The email is lower-cased and checked against the same format as the database rule
`chk_patient_email_format`. The phone uses the same pattern as `chk_patient_phone_format`. The room
is upper-cased and has to look like `R-12`. `consultationFee` must be a JSON number (not the string
`"100"`), more than 0, with at most 2 decimals, and no more than 99,999,999.99, the largest
`DECIMAL(10,2)`.

Unknown fields are rejected, so `"age": 30` gives a 400. That catches typos like `"fullname"` that
would otherwise be silently ignored. Ids must match `^[1-9][0-9]*$` and fit in `INT UNSIGNED`, which
rules out `abc`, `0`, `-1`, `1.5` and `1e3`.

The database CHECKs are still the last line of defense (§8). The validators give friendly messages;
the CHECKs make sure nothing slips through.

### The SQL in the models

Every value is a `?` placeholder (`pool.execute`, a real prepared statement), and the SQL text is
always a fixed string, with no `${...}` and no `+`.

Partial updates are where people are usually tempted to build SQL from strings: you build
`SET col1 = ?, col2 = ?` from whichever fields were sent. I avoided that by giving each model one
fixed statement instead:

```sql
UPDATE patients SET full_name = COALESCE(?, full_name),
                    email     = COALESCE(?, email),
                    phone     = COALESCE(?, phone)
 WHERE id = ?
```

A field that wasn't sent is passed as `NULL`, and `COALESCE(NULL, full_name)` keeps the current
value. That's safe because every column is NOT NULL, so NULL is never a real new value, and the
validator rejects `null` from the client anyway. It's also atomic: there's no gap where the code
reads the row, merges the changes in JS and writes it back while another request changes it.

The update can return 404 without an extra query. mysql2 turns on the `CLIENT_FOUND_ROWS` flag, so
`affectedRows` counts the rows matched by `WHERE id = ?`, even if nothing actually changed. `0` means
the id doesn't exist, and that becomes a 404.

`LIMIT ? OFFSET ?` values are sent as strings, because MySQL 8 rejects JavaScript numbers (sent as
DOUBLE) for LIMIT placeholders in prepared statements. They're still placeholders, so the values
never touch the SQL text.

### Deleting: 409, never cascade

`fk_appt_patient` and `fk_appt_doctor` are `ON DELETE RESTRICT`, so MySQL refuses the DELETE and the
API answers 409: *"Doctor 1 has appointments and cannot be deleted. Appointments (including cancelled
ones) are kept permanently as refund history."* A patient or doctor with no appointments, like the
seeded Dr. Owusu-Ansah, deletes normally with 204. The model doesn't check first. It just tries the
DELETE and lets the database enforce the rule. Checking first and then deleting would also leave a
gap where someone could book an appointment in between.

MySQL reports this refusal with two different codes depending on the user's privileges. A user who
can read the child table's definition gets `ER_ROW_IS_REFERENCED_2` (1451), which includes the
constraint name. The least-privilege `medibook_user` gets `ER_ROW_IS_REFERENCED` (1217), which
doesn't. So the model doesn't try to read the constraint name. `remove()` catches either code
(`isRowReferenced()` in `dbErrorMap.js`) and returns `REMOVE_OUTCOME.HAS_APPOINTMENTS`, and the
controller, which knows whether it's dealing with a patient or a doctor, writes the message.

### Errors: `AppError` and one central middleware

`AppError` (`src/utils/AppError.js`) is an `Error` that carries an HTTP status and, optionally,
`details`. It has shortcut helpers: `AppError.badRequest(...)`, `.notFound`, `.conflict`,
`.unprocessable` and `.serviceUnavailable`. A controller just does
`throw AppError.notFound('Patient 9999 not found')`.

There's no try/catch in the controllers. Express 5 automatically passes a rejected promise from an
`async` handler to the error middleware, so every controller is just "validate, call the model,
respond".

`errorHandler` (`src/middleware/errorHandler.js`) is the only place that turns an error into a
response. It works through these cases in order:

1. An `AppError` is used as it is.
2. Invalid JSON from `express.json()` becomes 400 "Malformed JSON in request body", and a body over
   100 KB becomes 413.
3. Known MySQL errors go through `mapDbError` (`src/utils/dbErrorMap.js`, a pure function).
   `ER_DUP_ENTRY` becomes 409: the constraint name is read from MySQL's message
   (`for key 'patients.uq_patient_email'`) and mapped to a friendly message and the field (`email`),
   which is why every constraint has a name. `ER_ROW_IS_REFERENCED_2` becomes 409 with the
   refund-history explanation. `ER_NO_REFERENCED_ROW_2` becomes 404, and
   `ER_CHECK_CONSTRAINT_VIOLATED` and `ER_DATA_TOO_LONG` become 400. Connection or login failures
   (`ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, …) become 503.
4. Anything else becomes 500 "Internal server error". The real error and stack trace are only printed
   on the server console, so internal details like SQL or file paths never reach a client.

So there's one error shape everywhere, `{ "error": { "status", "message", "details"? } }`, whether
it's a validation error, an unknown route, a 405, a database conflict or a 500. In `app.js` the
routes come first, then `notFound` for any URL nothing matched, then `errorHandler` last, because
Express only reaches it when something called `next(err)` or threw.

---

## 11. Booking

### Endpoints

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/api/appointments` | 201 + `Location: /api/appointments/{id}` | 400, 404, 409 (+ waitlist offer), 422, 503 |
| GET | `/api/appointments/:id` | 200, with patient and doctor names | 400, 404 |
| GET | `/api/doctors/:id/appointments?date=YYYY-MM-DD` | 200 + `meta: { booked, dailyCap, remaining }` | 400, 404 |

The request body is `{ "patientId": 5, "doctorId": 2, "appointmentDateTime": "2027-05-03 10:00",
"amountPaid": 80 (optional), "joinWaitlist": true (optional) }`.

I used `POST /api/appointments` rather than `POST /api/doctors/2/appointments` because an
appointment belongs as much to the patient as to the doctor, so neither one is really its parent. A
top-level collection gives each appointment one URL (`/api/appointments/17`), which is also where
cancelling happens (`PATCH /api/appointments/17/cancel`, §12). `GET /api/doctors/:id/appointments?date=`
is just a read-only view of one doctor's day, useful for demos and for a receptionist's screen.

### The order of the checks, and the status each one gives

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

`"2027-02-30 10:00"` and `"abc"` aren't valid times at all, so they're 400. `"2027-05-03 09:15"` is a
perfectly good time that the clinic's rules don't allow, so it's 422, the same idea as in §10. A 404
means the request names a patient or doctor that doesn't exist; the URL itself is fine, so it's a 404
for the thing being referred to, not a 400.

A 409 means the request is valid but clashes with the current state of the data: the slot is taken,
the day is full, or the patient is already busy. Trying again later might work, and that's exactly
when a waitlist makes sense. An `amountPaid` above the fee is a 422, because it's a rule about
meaning ("never charge more than the fee"), not about syntax. A negative or 3-decimal `amountPaid`
is a 400 because the shape is wrong.

The cheap checks come first. Steps 1 and 2 don't need the database, so a bad request is turned
away before a connection or a lock is ever taken.

### Handling simultaneous bookings: two layers

The first layer is `SELECT ... FROM doctors WHERE id = ? FOR UPDATE`. That row lock makes every
booking for the same doctor wait its turn, one transaction at a time. While the lock is held,
"count the day's booked appointments, then insert" is safe, because no other booking for that
doctor can get in between the count and the insert.

Without the lock, the daily cap breaks. Say a day has 11 bookings and two requests arrive for two
different free slots. Both run `COUNT(*)`, both see 11, which is under 12, and both insert, so the
day ends up with 13. No UNIQUE index can stop that, because the two rows are for different times.
`scripts/concurrency-daily-cap.js` shows the fix working: 6 requests at once for 6 different slots,
with room for 2, and exactly 2 succeed and the day stops at 12.

I lock the doctor row rather than the appointments because a doctor row always exists, even on an
empty day, so there's always something to lock. Locking "all of that day's appointments" with
`SELECT ... FOR UPDATE` on a range would depend on InnoDB gap locks, which are harder to reason
about and more likely to deadlock. Bookings for different doctors lock different rows, so they
still run in parallel.

The second layer is `UNIQUE (doctor_id, active_slot)`, the final guarantee. Even if the lock were
removed, forgotten in some future code path, or skipped by someone running an INSERT by hand, the
database itself refuses a second booked row for the same doctor and time (`ER_DUP_ENTRY`), and the
API turns that into a 409 "slot taken". Without the index, being correct would depend on every code
path remembering to take the lock, whereas an index can't be forgotten.
`scripts/concurrency-same-slot.js` sends 20 requests at once for one slot and gets exactly one 201
and nineteen 409s.

I need both because each one covers what the other can't. The lock fixes the race the index can't
see, which is the daily cap across different slots. The index guarantees the most important rule,
no double booking, whatever else happens. `uq_appt_patient_active_slot` does the same for "a
patient can't be in two places at once", even across two doctors, where the two bookings take
different doctor locks but share the same patient.

The booking transaction uses READ COMMITTED. Under MySQL's default, REPEATABLE READ, plain reads
see a snapshot. With READ COMMITTED, once the doctor lock is held, the `COUNT(*)` sees every booking
committed by whichever transaction held the lock before, so the count is never out of date.

"That day" is written as `appt_datetime >= '2027-03-15 00:00:00' AND appt_datetime < '2027-03-16 00:00:00'`,
not `DATE(appt_datetime) = ?`. Wrapping the column in a function would stop MySQL from using
`idx_appt_doctor_datetime (doctor_id, appt_datetime)`. Both ends of the range are worked out in Node
(`dayRange()` in `utils/clock.js`) and passed as `?`, with no `NOW()` or `CURDATE()` (§4).

Each attempt takes one connection from the pool. Every early exit (missing doctor or patient, over
the fee, day full) calls `ROLLBACK`, any thrown error is rolled back too, and `finally` always
`release()`s the connection. So a failed booking can never leak a connection or leave a lock held.

Deadlocks and lock timeouts (`ER_LOCK_DEADLOCK`, `ER_LOCK_WAIT_TIMEOUT`) are temporary: the same
request would very likely work a moment later. InnoDB has already rolled back the losing
transaction, so the model just retries the whole transaction, up to `BOOKING_MAX_ATTEMPTS = 3`
attempts in total. If it still fails, the error reaches the middleware and becomes 503 "The clinic is
very busy right now. Please try again in a moment." 503 means "temporary, try later". Business
results like "slot taken" or "day full" are never retried, because they're real answers, not
glitches.

`bookAppointment()` returns an outcome instead of throwing:
`{ outcome: 'BOOKED' | 'DOCTOR_NOT_FOUND' | 'PATIENT_NOT_FOUND' | 'AMOUNT_EXCEEDS_FEE' | 'DAY_FULL' |
'SLOT_TAKEN' | 'PATIENT_DOUBLE_BOOKED' }`. It only throws for unexpected database errors. The model
knows nothing about HTTP. The controller maps the outcomes to 404, 409 or 422, and the waitlist
worker (§14) maps the same outcomes to "permanent failure, try the next patient", while a thrown
error means "temporary, put the patient back". It's one model function with two callers and
exactly the same rules.

### appt_ref is made before the insert

The format is `AP-YYYYMMDD-XXXX` (for example `AP-20270503-Y97V`): the appointment date plus 4 random
characters from `0-9A-Z`, which gives 36⁴, about 1.7 million codes per day, using
`crypto.randomInt`. It's created in Node before the INSERT, so `appt_ref` is NOT NULL and UNIQUE
from the very first moment, and there's never a moment where the row exists without a reference.
If two bookings ever drew the same code, the INSERT fails on `uq_appt_ref`, and the model makes a
new code and tries again, within `BOOKING_MAX_ATTEMPTS`. The function takes the random source as a
parameter, so the unit tests can make it predictable.

### amountPaid

By default the patient pays the doctor's current `consultation_fee`. The fee is read inside the
transaction while the doctor lock is held, so it's the fee in force at the moment of booking.

`amountPaid` is optional, for discounts (the spreadsheet's AP-002 paid 120.00 on a 150.00 fee). It
has to be a JSON number with at most 2 decimals, between 0 and the fee; 0 means a free visit.
Shape errors (negative, `"50"`, 3 decimals) give 400, and going above the fee gives 422. The
comparison is done in whole cents (`toCents`), so floating-point noise can never decide whether
150.00 is more than 150.

The fee rule can't be a CHECK constraint, since a CHECK can't read `doctors`, which is why it's in
the booking code. `chk_appt_amount_paid_non_negative` still guards `>= 0` in the database.

### The waitlist offer on a 409

"Slot taken" and "day full" answer with:

```json
{ "error": { "status": 409, "message": "Doctor 2 is already booked at 2027-05-03 10:00",
    "waitlistAvailable": true, "waitlistType": "slot",
    "hint": "Resend the same request with \"joinWaitlist\": true to join the waitlist for this slot." } }
```

`waitlistType: "slot"` means that exact time was taken, so you'd wait for that slot. `"day"` means
the whole day reached 12, so you'd wait for any slot that frees up that day.

Joining is opt-in: the client sends the same request again with `"joinWaitlist": true`. The booking
is always tried first, and only if it's still full does the patient join the waitlist (202
Accepted). If the slot freed up in the meantime, they just get the appointment (201). That keeps it
to one endpoint and avoids acting on an out-of-date "join" decision.

"The patient already has an appointment at that time" gets no offer, because waiting wouldn't help.
`waitlistService.joinWaitlist()` is the one place where a Redis problem becomes a 503, so a Redis
outage only affects joining the waitlist, never the booking itself.

### After the commit, and only then

`bookingEvents.onAppointmentBooked(appointment, { source })` writes the `APPOINTMENT_BOOKED` audit
line (§13) and queues the confirmation job (§14). It's only called once `COMMIT` has succeeded.
Logging "booked" for a booking that then got rolled back would be a lie, and sending a confirmation
SMS for it would be worse. Neither step throws: the booking is already saved, so a logging or Redis
failure mustn't turn a success into a 500. The worker uses the same function for promoted bookings
(`source: 'waitlist'`).

### Demo scripts (`scripts/`)

`npm run demo:same-slot`, `npm run demo:daily-cap` and `npm run demo:concurrency` (both together)
call the running API over HTTP, so no SQL lives outside the models. Each run creates the demo
patients it needs (`demo.patient.NN@medibook.test`) and picks the first empty day for doctor 2 in
June or July 2027, so the demos can be run again in the video without reloading the database. They
print PASS or FAIL and exit with code 1 if they fail.

---

## 12. Cancellation and refunds

The endpoint is `PATCH /api/appointments/:id/cancel`, with no body (or `{}`).

It's PATCH, not DELETE, because cancelling changes the appointment's state (`status`,
`cancelled_at`, `refund_percent`, `refund_amount`). The row is kept forever for refund history and
revenue. `DELETE` would tell the client the resource is gone, and that isn't true.

The client can never send refund values. Any field in the body gives a 400: *"Cancellation takes no
fields: the refund is computed by the server"*. The refund is always calculated on the server from
the clinic clock.

| Status | When |
|---|---|
| 200 | cancelled: `{ data: { ...appointment, refundPercent, refundAmount, hoursNotice } }` |
| 400 | bad id, or any body field |
| 404 | unknown appointment |
| 422 | already cancelled ("already cancelled (on 2026-11-21 01:39:51)") or already started (appointment time ≤ now) |
| 405 | any other method (`Allow: PATCH`) |

"Already cancelled" is a 422, not a 409. The request is well-formed and the appointment exists, but
the rule "you can only cancel a booked appointment" says no. Trying again would never work, and
that's the difference from a 409 like "slot taken".

### The refund rule (`src/utils/refund.js`, pure)

`calculateRefund(amountPaid, appointmentDate, now)` takes `now` as a parameter, so the tests can use
fixed dates. The notice is the appointment time minus now, in exact milliseconds.

| Notice | Refund | Example (paid 100.00) |
|---|---|---|
| more than 48h (even 48h + 1 min) | 100% | 100.00 |
| exactly 48h | 50% | 50.00 |
| 36h | 50% | 50.00 |
| exactly 24h | 50% | 50.00 |
| 23h 59m | 0% | 0.00 |
| 0 or negative | (the API refuses: 422 "already started") | |

The boundaries come straight from the wording of the brief: "*more than* 48 hours → 100%; 24–48
hours → 50%; *less than* 24 hours → 0%". "More than 48" leaves out exactly 48, and "less than 24"
leaves out exactly 24, so both exact boundaries land in the 24–48 band, which includes both ends.
The numbers come from `REFUND_POLICY` in constants.

`hoursNotice` in the response is rounded to 2 decimals only so it reads nicely. The tier is decided
on the exact milliseconds, so 47h 59m 59s shows as 48 but still correctly gets 50%.

The money is worked out in whole cents:
`refundCents = Math.round(toCents(amountPaid) × percent / 100)`. For positive numbers `Math.round`
rounds halves up, which is exactly what MySQL's `ROUND(x, 2)` does with DECIMAL. So the database
CHECK `chk_appt_refund_matches_percent` (`refund_amount = ROUND(amount_paid × refund_percent / 100, 2)`)
always agrees with it: 99.99 × 50% = 49.995 → 50.00, and 120.01 × 50% = 60.005 → 60.01.
Floating-point noise can never decide a cent.

### The transaction (`appointmentModel.cancelAppointment`)

1. Set READ COMMITTED, then `SELECT ... FROM appointments WHERE id = ? FOR UPDATE` to lock that row.
2. Check the status again now that the lock is held. If two cancel requests for the same
   appointment arrive together, the second one waits at step 1, then sees CANCELLED and gets a
   422. The refund can never be paid twice.
3. Compare the appointment time with `clinicNow()`, which is passed in as a parameter, never `NOW()`.
4. Work out the refund with the pure function.
5. Write all four columns in one statement:
   `UPDATE appointments SET status = ?, cancelled_at = ?, refund_percent = ?, refund_amount = ?
   WHERE id = ? AND status = ?`. That's how "the cancellation and its refund record succeed or fail
   together" is met: one statement inside one transaction, backed up by
   `chk_appt_status_consistency`, which rejects a half-cancelled row. If the UPDATE doesn't change
   exactly 1 row, it throws and everything is rolled back.
6. Commit, then return the updated row.

The slot frees itself. The generated column `active_slot` becomes NULL when the status becomes
CANCELLED, so `uq_appt_doctor_active_slot` stops blocking that time. Another patient can book it
straight away, while the cancelled record stays for refund history. You can see this live: cancel,
then book the same slot again and get a 201.

Only after the commit, `bookingEvents.onAppointmentCancelled(appointment, { source, hoursNotice })`
writes the `APPOINTMENT_CANCELLED` audit line and queues the "slot-freed" job for the waitlist worker.
Neither step can throw, so a logging or Redis problem can never turn a committed cancellation into a
500.

---

## 13. Audit log with the `fs` module

`log(event, payload)` in `src/services/auditLogger.js` adds one JSON line per event to
`logs/audit.log`. The folder comes from `LOG_DIR` in `.env`, defaults to `logs`, and is relative to
the project root.

```json
{"timestamp":"2026-11-20T23:39:51.460Z","event":"APPOINTMENT_CANCELLED","appointmentId":17,"apptRef":"AP-20261124-DP7R","patientId":1,"doctorId":2,"appointmentDateTime":"2026-11-24 09:00","amountPaid":100,"refundPercent":100,"refundAmount":100,"hoursNotice":79.34,"source":"api"}
```

It only uses async calls from `fs/promises` (`mkdir` and `appendFile`), never `*Sync`. A `*Sync`
call would freeze the whole server, including every other request, while the disk did its work.

It creates `logs/` the first time it runs. `mkdir(dir, { recursive: true })` runs once and its
promise is saved, so calls that arrive at the same time share it. If it fails, the saved promise is
cleared so the next event tries again.

Each line is a single `appendFile` on a file opened in append mode (O_APPEND), so every small line
is written whole at the end of the file and two events never get mixed together. There's a unit test
with 20 writes at once, and 60 lines from a live run were all valid JSON.

A logging failure never fails the request. Everything is inside `try/catch`, and a failure only
prints one `console.error` line; `log()` never throws or rejects. The exception is when writing the
line is the job itself. The worker's confirmation processor uses `logStrict()`
(`log(event, payload, { strict: true })`), which prints the error and then rejects. The BullMQ job
fails and is retried with backoff, so a confirmation is never marked "completed" while its
`NOTIFICATION_SENT` line was lost. No HTTP request uses strict mode.

The file is in JSON Lines format: every line is a complete JSON object, so the file can keep growing
forever and still be read one line at a time (with `jq`, a spreadsheet import, or `JSON.parse` per
line).

There are two clocks in each line, on purpose. `timestamp` is the real UTC moment of the event,
which is unambiguous for an audit trail. `appointmentDateTime` and `cancelledAt` are clinic
wall-clock times (§4).

The events are `APPOINTMENT_BOOKED`, `APPOINTMENT_CANCELLED`, `WAITLIST_JOINED`, `WAITLIST_PROMOTED`,
`WAITLIST_PROMOTION_FAILED` and `NOTIFICATION_SENT`, all named in `AUDIT_EVENT`.

`createAuditLogger({ dir, fs })` lets the tests use a temporary folder and a fake `fs` that fails on
purpose. The shared logger is created the first time it's used, so `LOG_DIR` is read after `.env`
has loaded. `logs/` is in `.gitignore` because it's runtime data, not source code.

---

## 14. Queues, the Redis waitlist and the worker

### Two tools for two jobs

| | BullMQ queues | Plain Redis lists |
|---|---|---|
| Used for | the jobs: `slot-freed`, `send-confirmation` | the waitlist itself |
| Why | jobs need retries with backoff, and failed jobs kept to look at; BullMQ does that already | the waitlist is data people look at (`GET /api/doctors/:id/waitlist`) and it has to be strictly first in, first out; a list is exactly that |

The job options are `attempts: 5`, exponential backoff starting at 2 s, and `removeOnFail: false`
so failed jobs stay visible. The last 1000 completed jobs are kept as well.

### Waitlist keys and order

```
waitlist:doctor:2:slot:2027-08-02T10:00   waiting for that exact slot
waitlist:doctor:2:day:2027-08-03          waiting for ANY slot that day (the day was full)
<list key>:processing                     the entry being promoted right now
waitlist:failed                           permanent failures, with the reason
```

Each entry is `{ patientId, doctorId, requestedDateTime, type, joinedAt }`. Joining uses `RPUSH`,
which adds to the end, and promoting uses `LMOVE ... LEFT`, which takes from the front, so it's
first come, first served.

A 409 "slot taken" offers the slot list and a 409 "day full" offers the day list. When a slot frees
up, the worker serves the exact-slot list first, then the day list.

Nobody can join twice. A small Lua script checks the list and its processing list for the patient
and only then does the `RPUSH`. Because it runs atomically inside Redis, two joins at the same moment
can't both get in; the second gets 409 "already on the slot waitlist". A patient who already has a
booked appointment at that time can't join either (409), because the promotion could never work.

`GET /api/doctors/:id/waitlist` finds the doctor's lists with `SCAN`, never `KEYS`, which would
block Redis, and shows the slot lists, day lists, processing entries and failed entries with their
positions.

### The worker is a separate process (`npm run worker`)

The web server only adds jobs, and `src/workers/worker.js` is what runs them. The server never
imports the worker, so slow background work can never slow down an HTTP request, and either process
can restart without the other.

Here's what happens with a slot-freed job, step by step:

1. If the freed slot can't be booked any more (it's now in the past, say), the entries on its slot
   list move to `waitlist:failed` with that reason.
2. `LMOVE waitlist processing LEFT RIGHT` moves the patient who has waited longest into the
   processing list, atomically. This is the "reliable pop" pattern: at every moment the patient is
   in exactly one Redis list, so a crash can't make them disappear.
3. The worker books them with the same `appointmentModel.bookAppointment(buildBookingRequest(...))`
   the API uses: the same transaction, doctor lock, daily cap, unique indexes and outcomes.
4. Then it acts on the result:

| Result | Class | What happens to the entry |
|---|---|---|
| BOOKED | success | removed from processing only now, after the COMMIT; audit `WAITLIST_PROMOTED`; confirmation job queued |
| patient/doctor deleted, patient already booked at that time, amount above fee, unreadable entry | permanent | moved to `waitlist:failed` with the reason, audit `WAITLIST_PROMOTION_FAILED {permanent: true}`, then try the next patient |
| SLOT_TAKEN / DAY_FULL | slot gone | someone else got the slot first, which isn't this patient's fault, so they go back to the front of their list; no retry, since the slot has gone |
| thrown error (DB/Redis down…) | temporary | back to the front of their list, audit `{permanent: false}`; the job is rethrown so BullMQ retries it with backoff |

So a patient is never lost from both Redis and MySQL. At any moment they're still waiting, being
processed, booked in MySQL, or in `waitlist:failed` with a reason. Nobody loops forever either:
permanent failures leave the list, and temporary ones are retried at most 5 times.

I tested this live. Patients B and C were waiting for a slot, then B booked the same time with a
different doctor, and then a cancellation freed the slot. The worker moved B to `waitlist:failed`
("patient already has another appointment at that time") and booked C within a second.

`slot-freed` jobs run one at a time, so two promotions never compete for the same freed slot. The
doctor lock and unique index would protect the data anyway; this just avoids pointless conflicts.

When the worker starts, before taking any jobs, it moves everything left in `:processing` lists back
to the front of their waitlist, oldest first. That covers a crash between the LMOVE and the final
LREM.

The waitlist sweep (`src/workers/waitlistSweep.js`) runs at start-up and then every
`WAITLIST_SWEEP_INTERVAL_MS`, which is 60 s, and never two runs at once. For every waitlist that
isn't empty and whose slot (or day) really has room, it queues a new slot-freed job. That recovers
promotions whose job was lost while Redis was down, without restarting the worker. If it guesses
wrong, nothing bad happens; the patient just goes back to the front.

The confirmation job writes `NOTIFICATION_SENT` with a pretend SMS, for example *"SMS to patient 1
(Ama Mensah): Your appointment AP-20261124-DP7R with Dr. Efua Adjei is confirmed for 2026-11-24 09:00.
Amount paid: 100.00."* Every confirmed appointment, from the API or from a promotion, queues one. The
line is written with `logStrict()`, so if it can't be written the job fails and gets retried (§13).

On shutdown (Ctrl+C or SIGTERM), the worker closes the BullMQ workers first, letting running jobs
finish, then the Redis connections, the producer queues and the MySQL pool.

### What happens when Redis is down

MySQL is the source of truth, so booking (201) and cancelling (200) still work. The confirmation or
slot-freed job just isn't queued, and the server prints one warning.

Joining or reading the waitlist gives a 503, "The waitlist is temporarily unavailable (Redis is
down)". The waitlist lives in Redis, and being honest about that is better than pretending.

The server's Redis client fails fast: `enableOfflineQueue: false`, one retry, a 2 s command timeout,
and at most 1.5 s of waiting on the first connection. So an HTTP request can never hang on Redis.

The trade-off is that a slot-freed job lost while Redis was down means that slot doesn't get an
immediate promotion. The worker's waitlist sweep recovers it within one sweep interval (60 s) of
Redis coming back, with no restart needed. A confirmation SMS that couldn't even be queued while
Redis was down isn't sent later.

The worker's own connections wait and reconnect (BullMQ needs `maxRetriesPerRequest: null`), so it
picks up again by itself when Redis is back.

---

## 15. Statistics and reports: advanced SQL

Every figure is calculated by the SQL in the models (`statisticsModel.js`, `reportModel.js`), and the
JavaScript only renames columns. The brief marks this specifically ("not fetched raw and computed in
JavaScript"). It's also the better design: the database does the totals right next to the data and
its index, and the numbers can't drift from what's stored. Every date is worked out in Node and
passed as `?`, and the rule numbers (`DAILY_CAP`, `BUSY_THRESHOLD`, `STATS_WINDOW_DAYS`) are passed
as parameters too, never typed into the SQL.

### `GET /api/doctors/:id/statistics?from=YYYY-MM-DD`

These are the definitions:

- **revenueCollected** is `SUM(amount_paid − COALESCE(refund_amount, 0))` over all of the doctor's
  appointments, ever. A booked row adds what was paid, and a cancelled row adds what was kept after
  the refund (0 after a 100% refund). So it's the money actually collected.
- **upcomingAppointments** counts booked appointments with `appt_datetime > now` (clinic now). It
  doesn't depend on `from`.
- **The window** is the 7 days starting at `from` (clinic today by default), from `from` 00:00 up to,
  but not including, `from + 7` 00:00. `?from` exists because the seed's appointments are in March
  2027, so `?from=2027-03-15` shows the busy week.
- **utilization** is the number booked in the window ÷ (`DAILY_CAP` × 7) × 100, rounded to 1 decimal
  in SQL.

**Query 1, the summary (one row).** I've shortened the outer column list here; the full text is in
`findDoctorSummary` in `src/models/statisticsModel.js`.

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

Going through it:

- `FROM doctors d LEFT JOIN appointments a` starts from the doctor, so a doctor with no
  appointments still gives one row (with NULLs for `a.*`), and an unknown id gives no row at all,
  which becomes a 404.
- `WHERE d.id = ?` with `GROUP BY d.id, d.full_name` gives one row for one doctor.
- In `COALESCE(SUM(amount_paid − COALESCE(refund_amount, 0)), 0)`, the inner COALESCE treats "no
  refund" as 0, and the outer one turns the NULL total of a doctor with no appointments into 0.
- `COUNT(CASE WHEN … THEN 1 END)` is conditional aggregation. The CASE gives 1 for rows that match
  and NULL otherwise, and COUNT ignores NULLs, so several different counts come out of one pass over
  the rows.
- `? * ?` is `DAILY_CAP × STATS_WINDOW_DAYS`, which is 84 slots of capacity.
- The outer `SELECT ... ROUND(... * 100, 1)` reuses the two totals without repeating them.

**Query 2, one row per day, including days with nothing booked (recursive CTE):**

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

The problem this solves is that `GROUP BY DATE(appt_datetime)` only returns days that have
appointments, so the empty days would be missing.

- `WITH RECURSIVE`: the starting row, `SELECT CAST(? AS DATE), 1`, is day 1 (`from`). The recursive
  part adds one day at a time until `n` reaches 7, which gives a 7-row calendar.
  `CAST(? AS DATE)` fixes the column type, because in a recursive CTE the first row decides the type.
- `LEFT JOIN appointments` attaches each day's bookings to the calendar and keeps the days that have
  none. The doctor and status filters go in `ON`, not `WHERE`, because a WHERE on `a.*` would throw
  the empty days away and turn it back into an inner join.
- `>= cal_date AND < cal_date + INTERVAL 1 DAY` compares the raw column, so `idx_appt_doctor_datetime`
  can be used. `DATE(appt_datetime) = cal_date` would stop the index from working.
- It's `COUNT(a.id)`, not `COUNT(*)`. An empty day has one row with a NULL `a.id`, so `COUNT(a.id)`
  gives 0 where `COUNT(*)` would say 1.

The live result for doctor 1 with `?from=2027-03-15` is revenue 1620, upcoming 11, per day
11, 0, 0, 0, 0, 0, 0, and utilization 11 / 84 = 13.1%. Doctor 3 gets revenue 0, upcoming 0 and
seven days of 0.

### `GET /api/reports/doctors`: every doctor, including those with no appointments

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

The `LEFT JOIN`, rather than a plain `JOIN`, is what makes Dr. Owusu-Ansah appear even with no
appointments. An inner join would drop that doctor from the report. `COUNT(a.id)` gives 0 there, and
`COALESCE(SUM(...), 0)` gives 0 instead of NULL. Every column that isn't a total is in the
`GROUP BY`, as MySQL's ONLY_FULL_GROUP_BY mode requires. The rows are ordered by revenue, top earner
first, with the id as a stable tie-breaker.

Live, it gives Boateng 13 appointments and 1620, Adjei 3 and 300, and Owusu-Ansah 0 and 0, which
matches §9.

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

`WHERE a.status = ?` (BOOKED) leaves out cancelled rows, since they don't use up capacity.
`GROUP BY doctor, DATE(...)` makes one group per doctor per day.

It has to be `HAVING`, not `WHERE`. WHERE filters rows before they're grouped and can't see
`COUNT(*)`, while HAVING filters the groups after they've been counted. `> ? * ?` is
`> BUSY_THRESHOLD × DAILY_CAP`, so `> 0.8 × 12`, which is `> 9.6`, meaning 10 or more. Both numbers
are parameters from the constants. `ROUND(COUNT(*) / ? * 100, 1)` gives the percentage of capacity.

Live, it returns exactly one row: Dr. Boateng on 2027-03-15, 11 booked, 91.7%.

---

## 16. Translation and localization: `GET /feedback`

The locale files `locales/en.json` and `locales/fr.json` have exactly the same keys: title, heading,
instructions, dateLabel, the 5 questions, the submit label and so on. The English questions are the
brief's text word for word (a unit test checks this), and the French ones are translations.

The files are loaded once, asynchronously, at start-up. `loadLocales()` (using `fs/promises`) starts
when the feedback controller is first required and checks every file: all keys present and exactly
5 questions. Each request awaits that same promise, which has already finished by then, so there's
no file reading per request and no `*Sync`. If a locale file is broken, that's reported at start-up
and `/feedback` answers 500.

`?lang=fr` gives French. A missing, unsupported (`xx`), repeated (`?lang=fr&lang=en`, which arrives as
an array) or non-string value gives English (`I18N.DEFAULT_LANGUAGE`) and never crashes. `FR` and
` fr ` work too, because the value is trimmed and lower-cased. The page also sets
`<html lang="en|fr">` and a `Content-Language` header.

The date is formatted with `Intl.DateTimeFormat('en-GB' | 'fr-FR', { dateStyle: 'full', timeZone:
CLINIC_TIMEZONE })`, giving *"Saturday, 21 November 2026"* or *"samedi 21 novembre 2026"*. It formats
the real current moment in the clinic's time zone, so the page shows the clinic's date even near
midnight or on a server in another zone. I chose en-GB (day before month) because it suits a clinic
in Africa better than en-US.

`renderFeedbackPage()` is a pure function, and every value it puts into the page goes through
`escapeHtml` (`& < > " '`), so translated text can never inject HTML or a script. There's a unit test
for this with a malicious title.

The form has exactly 5 `<label>` and `<textarea required>` pairs and a submit button. It submits with
GET back to the same page, keeping the language. The answers aren't stored, since the brief only asks
for a simple page, and the page says so.
