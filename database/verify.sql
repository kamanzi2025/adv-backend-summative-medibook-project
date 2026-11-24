-- MediBook constraint checks, for showing the rules working in the demo.
-- Nothing is saved: every test insert runs inside a transaction that gets rolled back.
--
-- Run it with --force so the client carries on after the errors we expect.
-- Pipe the file in rather than using the client's `source` command, which stops
-- at the first error even with --force. From PowerShell, in the project root:
--   $mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
--   cmd /c "`"$mysql`" -u medibook_user -p --table --force medibook < database\verify.sql"

USE medibook;

-- 1. Rows per table. Expected: patients 11, doctors 3, appointments 16.
SELECT 'patients' AS table_name, COUNT(*) AS row_count FROM patients
UNION ALL SELECT 'doctors',      COUNT(*) FROM doctors
UNION ALL SELECT 'appointments', COUNT(*) FROM appointments;

-- 2. Bookings per doctor per day. Expected: doctor 1 on 2027-03-15 has 11 booked and 1 cancelled.
SELECT doctor_id,
       DATE(appt_datetime)       AS appt_date,
       SUM(status = 'BOOKED')    AS booked,
       SUM(status = 'CANCELLED') AS cancelled
FROM appointments
GROUP BY doctor_id, DATE(appt_datetime)
ORDER BY doctor_id, appt_date;

START TRANSACTION;

-- 3. Should fail with ERROR 1062 (uq_appt_doctor_active_slot): a second booked row
--    in Dr. Boateng's 2027-03-15 09:00 slot, which appointment 1 already holds.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270315-T001', 5, 1, '2027-03-15 09:00:00', 150.00, 'BOOKED', '2026-11-20 12:00:00');

-- 4. Should succeed (1 row): a cancelled row in that same slot is fine.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status,
                          booked_on, cancelled_at, refund_percent, refund_amount)
VALUES ('AP-20270315-T002', 6, 1, '2027-03-15 09:00:00', 150.00, 'CANCELLED',
        '2026-11-19 09:00:00', '2026-11-20 09:00:00', 100, 150.00);

-- 5. Should fail with ERROR 1062 (uq_appt_patient_active_slot): Ama (patient 1) already
--    has 2027-03-15 09:00 with doctor 1, so can't see doctor 2 at the same time.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270315-T003', 1, 2, '2027-03-15 09:00:00', 100.00, 'BOOKED', '2026-11-20 12:00:00');

-- 6. Should fail with ERROR 3819 (chk_appt_slot_minutes): 09:15 isn't on a half-hour boundary.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270316-T004', 5, 2, '2027-03-16 09:15:00', 100.00, 'BOOKED', '2026-11-20 12:00:00');

-- 7. Should fail with ERROR 3819 (chk_appt_working_hours): 17:00 is after the last slot at 16:30.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270316-T005', 5, 2, '2027-03-16 17:00:00', 100.00, 'BOOKED', '2026-11-20 12:00:00');

-- 8. Should fail with ERROR 3819 (chk_appt_status_consistency): cancelled but no refund details.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270316-T006', 5, 2, '2027-03-16 10:00:00', 100.00, 'CANCELLED', '2026-11-20 12:00:00');

-- 9. The 09:00 slot now has 1 booked row (active_slot filled) and 2 cancelled rows (active_slot NULL).
SELECT id, appt_ref, patient_id, status, active_slot
FROM appointments
WHERE doctor_id = 1 AND appt_datetime = '2027-03-15 09:00:00'
ORDER BY id;

ROLLBACK;

-- 10. After the rollback nothing has changed. Expected: 16.
SELECT COUNT(*) AS appointments_after_rollback FROM appointments;
