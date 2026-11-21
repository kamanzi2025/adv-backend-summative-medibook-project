-- =====================================================================
-- MediBook: constraint verification (demo script). Changes NOTHING:
-- every test insert runs inside a transaction that is rolled back.
-- Run with --force so the client continues after the EXPECTED errors.
-- Feed the file through stdin: the client's `source` command stops at the
-- first error even with --force. From PowerShell, in the project root:
--   $mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
--   cmd /c "`"$mysql`" -u medibook_user -p --table --force medibook < database\verify.sql"
-- =====================================================================

USE medibook;

-- 1. Row counts per table (expected: patients 11, doctors 3, appointments 16).
SELECT 'patients' AS table_name, COUNT(*) AS row_count FROM patients
UNION ALL SELECT 'doctors',      COUNT(*) FROM doctors
UNION ALL SELECT 'appointments', COUNT(*) FROM appointments;

-- 2. Bookings per doctor-day (expected: doctor 1 on 2027-03-15 has 11 BOOKED + 1 CANCELLED).
SELECT doctor_id,
       DATE(appt_datetime)       AS appt_date,
       SUM(status = 'BOOKED')    AS booked,
       SUM(status = 'CANCELLED') AS cancelled
FROM appointments
GROUP BY doctor_id, DATE(appt_datetime)
ORDER BY doctor_id, appt_date;

START TRANSACTION;

-- 3. EXPECTED ERROR 1062 on uq_appt_doctor_active_slot:
--    a second BOOKED row in Dr. Boateng's 2027-03-15 09:00 slot (held by appointment 1).
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270315-T001', 5, 1, '2027-03-15 09:00:00', 150.00, 'BOOKED', '2026-11-20 12:00:00');

-- 4. EXPECTED SUCCESS (1 row affected): a CANCELLED row in that same slot is allowed.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status,
                          booked_on, cancelled_at, refund_percent, refund_amount)
VALUES ('AP-20270315-T002', 6, 1, '2027-03-15 09:00:00', 150.00, 'CANCELLED',
        '2026-11-19 09:00:00', '2026-11-20 09:00:00', 100, 150.00);

-- 5. EXPECTED ERROR 1062 on uq_appt_patient_active_slot:
--    Ama (patient 1) already holds 2027-03-15 09:00 with doctor 1; she cannot also see doctor 2 then.
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270315-T003', 1, 2, '2027-03-15 09:00:00', 100.00, 'BOOKED', '2026-11-20 12:00:00');

-- 6. EXPECTED ERROR 3819 on chk_appt_slot_minutes (09:15 is not a 30-minute boundary).
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270316-T004', 5, 2, '2027-03-16 09:15:00', 100.00, 'BOOKED', '2026-11-20 12:00:00');

-- 7. EXPECTED ERROR 3819 on chk_appt_working_hours (17:00 is after the last 16:30 slot).
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270316-T005', 5, 2, '2027-03-16 17:00:00', 100.00, 'BOOKED', '2026-11-20 12:00:00');

-- 8. EXPECTED ERROR 3819 on chk_appt_status_consistency (CANCELLED without refund data).
INSERT INTO appointments (appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES ('AP-20270316-T006', 5, 2, '2027-03-16 10:00:00', 100.00, 'CANCELLED', '2026-11-20 12:00:00');

-- 9. The 09:00 slot now has 1 BOOKED row (active_slot set) and 2 CANCELLED rows (active_slot NULL).
SELECT id, appt_ref, patient_id, status, active_slot
FROM appointments
WHERE doctor_id = 1 AND appt_datetime = '2027-03-15 09:00:00'
ORDER BY id;

ROLLBACK;

-- 10. After ROLLBACK the table is unchanged (expected: 16).
SELECT COUNT(*) AS appointments_after_rollback FROM appointments;
