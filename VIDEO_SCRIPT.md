# MediBook: 10-Minute Demo Script

A suggested order with the exact commands and the key "why" to say at each step. Times are
targets; the whole run is about 10 minutes. Every request is in [`requests.http`](requests.http)
(VS Code REST Client: click **Send Request**).

## Before you press record (not filmed)

```powershell
# Clean database (as root), empty Redis, no old audit log
$mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
& $mysql -u root -p -e "source database/schema.sql"; & $mysql -u root -p -e "source database/seed.sql"
docker compose up -d
docker exec medibook-redis redis-cli FLUSHALL
Remove-Item logs -Recurse -Force -ErrorAction SilentlyContinue
```
Open 3 terminals: **T1** for the API, **T2** for the worker, **T3** for commands.
Open `requests.http`, `schema-diagram.png` and `DESIGN_NOTES.md`.
Record between **09:00 and 16:00**, so the "today 16:30" refund demo is still in the future.

---

## 0:00 to 1:30 · Database design (Part A/B)

Show `schema-diagram.png`, then `database/schema.sql`.

Say:
- "The spreadsheet repeated patient and doctor data on every row, which causes update, insert and
  delete anomalies. In 3NF, patient fields depend only on the patient and doctor fields (specialty,
  fee, room) only on the doctor, so there are exactly 3 tables. `amount_paid` stays on
  appointments because it can differ from the fee: AP-002 paid 120 on a 150 fee."
- "Refunds and cancellations are columns on appointments, because we're limited to 3 tables and
  each is a 1:1 fact about the appointment."
- **The slot rule:** "`active_slot` is a STORED generated column: the slot time while BOOKED, NULL
  once CANCELLED. `UNIQUE(doctor_id, active_slot)` makes double booking impossible in the
  database itself, and since NULLs never collide, a cancelled slot is re-bookable while the
  cancelled row is kept."
- "Every constraint is named. CHECKs enforce 30-minute boundaries, 09:00–16:30, money ≥ 0, a refund
  that matches its percentage, and that a cancelled row carries all its refund data."

Optional proof (T3):
``cmd /c "`"$mysql`" -u medibook_user -p --table --force medibook < database\verify.sql"``
(with `$mysql` defined as in "Before you press record")
shows ERROR 1062 for the duplicate slot, the cancelled row accepted, and ERROR 3819 for 09:15 and
17:00. Then it rolls back.

## 1:30 to 2:15 · Start everything + tests

```powershell
npm start          # T1 → "listening", "[mysql] connected"
npm run worker     # T2 → "recovery: 0", "start-up sweep: 0", "listening on queues"
npm test           # T3 → 12 suites, all green
```

Say: "Tests only cover pure functions (refund, slot validation, waitlist logic, i18n) with fixed
dates and no MySQL or Redis. That's why the business rules are pure functions with `now` passed in."
Optionally: `docker compose stop` → `npm test` still green → `docker compose up -d`.

## 2:15 to 3:15 · Structure + CRUD (Part B/C.1)

Show the folders: `models/` (all SQL, `?` placeholders), `controllers/`, `routes/`.

In `requests.http`:
- `POST /api/patients` with every field bad → **400 listing all four problems**.
- Create → **201 + Location**, then PATCH phone → **200**.
- Duplicate email `AMA@mail.com` → **409**.
- `DELETE /api/doctors/1` → **409** "appointments are kept as refund history".
- `GET /api/patients/abc` → **400**; `/9999` → **404**; `PUT` → **405**.

Say: "PATCH, not PUT, because the receptionist changes one field. The partial update is ONE fixed
SQL statement with COALESCE: no SQL built from strings. Deletes are RESTRICT → 409, so financial
history is never cascaded away. One central error handler gives one error shape."

## 3:15 to 5:00 · Booking rules + concurrency (Part C.2)

In `requests.http` (booking section):
- Valid booking → **201**; follow the `Location` URL.
- 17:00, 08:30, 09:15, a past date → **422** with the broken rule; `2027-02-30` → **400**.
- The same slot again → **409** with `waitlistAvailable: true, waitlistType: "slot"`.
- `GET /api/doctors/1/appointments?date=2027-03-15` → 11 of 12; book the 12th → **201**; the 13th
  → **409** `waitlistType: "day"`.

Then (T3):
```powershell
npm run demo:concurrency
```
→ 20 simultaneous requests for one slot: **1 × 201, 19 × 409**. Then 6 simultaneous requests on a day
with room for 2: **2 × 201**, and the day stops at **exactly 12**.

Say: "Two layers. First, `SELECT … FOR UPDATE` on the doctor row makes bookings for one doctor run
one at a time, so 'count the day, then insert' can't race. Without it, two requests for
*different* slots would both see 11 and both insert: 13. A unique index can't catch that. Second,
the UNIQUE index is the final guarantee against double booking even if the lock were missing. 400
means malformed, 422 means a valid time the rules forbid, 409 means it conflicts with current
data."

## 5:00 to 6:15 · Cancellation + refunds (Part C.3)

In `requests.http` (cancellation section), book and cancel:
- today 16:30 → **0%**
- tomorrow 16:30 → **50%**
- in 3 days 10:00 → **100%**

Cancel again → **422**. Book the freed slot → **201**.

Show `src/utils/refund.js` and `tests/refund.test.js`.

Say:
- "The server computes the refund; any body field is a 400. More than 48h gives 100%. 24 to 48
  hours *inclusive* gives 50%, so exactly 48h and exactly 24h are both 50%, because the brief says
  'more than 48' and 'less than 24'. The amount is calculated in integer cents and rounds exactly
  like MySQL's ROUND, so the CHECK constraint always agrees."
- "The transaction locks the appointment row, re-checks the status (so a double cancel can't refund
  twice), and writes status plus refund in ONE UPDATE: they succeed or fail together. The row is
  kept; the generated column frees the slot."

## 6:15 to 8:00 · Waitlist + worker + failure handling (Part E)

Run the waitlist section of `requests.http` (steps 1–10) while **T2 is visible**:
- Patient 6 and patient 7 join → **202** (positions 1 and 2). Join again → **409**.
- `GET /api/doctors/2/waitlist` shows [6, 7].
- Patient 6 books the same time with another doctor. Then cancel patient 5.
- **T2** prints the promotion of patient 7 and the `[notify] SMS …` line. `GET waitlist` shows
  patient 6 under **failed** with the reason.

Say:
- "BullMQ is for jobs (retries, backoff, kept failures). Plain Redis lists hold the waitlist,
  because it must be strictly FIFO and inspectable: RPUSH to join, LMOVE LEFT to promote."
- "The worker is a separate process. It books through the *same* model function as the API."
- "Reliable pop: LMOVE moves the patient atomically into a processing list. They're removed only
  after the booking commits, so they're never lost from both Redis and MySQL. A temporary error →
  back to the front and retried with backoff. A permanent one, like patient 6 already being busy →
  `waitlist:failed` with the reason, then the next patient. On start-up the worker returns anything
  stuck in processing."

**Redis down** (T3): `docker compose stop` → book → **201** and cancel → **200** (warning in T1),
join waitlist → **503**. Then `docker compose up -d`.
Say: "MySQL is the source of truth, so bookings never depend on Redis. The trade-off is that a lost
slot-freed job is recovered by the worker's waitlist sweep, which runs every minute."

## 8:00 to 8:45 · Audit log (Part D)

```powershell
Get-Content logs\audit.log -Tail 8
```
Point out the BOOKED, CANCELLED, WAITLIST_PROMOTED, WAITLIST_PROMOTION_FAILED and NOTIFICATION_SENT lines.

Say: "`fs/promises` only, no *Sync, so the event loop never blocks. `mkdir` recursive once, then one
`appendFile` per JSON line. Everything is in try/catch: a log failure prints an error but never
fails the request. Lines are written only after COMMIT."

## 8:45 to 9:30 · Reports (Part C.4–C.6)

- `GET /api/doctors/1/statistics?from=2027-03-15` → revenue **1620**, per day **11, 0, 0, 0, 0, 0, 0**,
  utilization **11 / 84 = 13.1%**.
- `GET /api/reports/doctors` → Dr. Owusu-Ansah appears with **0 / 0**.
- `GET /api/reports/busy-days` → Dr. Boateng, 2027-03-15, **91.7%**.

Show `src/models/reportModel.js`.

Say: "All figures are computed in SQL. Revenue is paid minus refunded. A recursive CTE builds the 7
calendar days and LEFT JOINs the bookings, so empty days show 0. The doctors report uses LEFT JOIN
with COALESCE so a doctor with no appointments still appears. Busy days use HAVING COUNT > ? × ?,
with the cap and the 80% threshold passed as parameters, not hard-coded."

## 9:30 to 10:00 · Feedback page (Part G)

Open `http://localhost:3000/feedback`, then `?lang=fr`, then `?lang=xx` in the browser.

Say: "Title, instructions, the 5 questions and the button come from `locales/en.json` and
`fr.json`, loaded once at start-up with async fs. An unsupported language falls back to English.
The date uses Intl.DateTimeFormat (en-GB / fr-FR) in the clinic's time zone, and every value is
HTML-escaped."

Close: "Every decision is explained in DESIGN_NOTES.md, and every request is in requests.http."

---

## Likely viva questions (short answers)

- **Why not `DATE(appt_datetime) = ?`?** It wraps the column in a function, so the index can't be
  used. A half-open range `>= day AND < next day` can use it.
- **Why compute "now" in Node, not `NOW()`?** One clock for validation, SQL and tests, independent
  of the MySQL server's time zone. Tests pass a fixed `now`.
- **What if two people cancel the same appointment at once?** The second waits on the row lock,
  then sees CANCELLED → 422. The refund is paid once.
- **What if the worker crashes mid-promotion?** The entry is in the processing list. On restart,
  recovery moves it back to the front of the waitlist. If the booking had already committed, the
  unique indexes stop a duplicate, and the next attempt is classified as "already booked".
- **Why 202 for joining the waitlist?** The request was accepted, but the appointment will be
  created later, asynchronously, by the worker.
