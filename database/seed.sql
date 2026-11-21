-- =====================================================================
-- MediBook: sample data. Run AFTER schema.sql.
-- Explicit ids, FK-safe order (patients, doctors, appointments), one
-- transaction: either the whole seed loads or nothing does.
--
-- What the data demonstrates:
--   * Doctor 1 (Dr. Kwame Boateng): 2027-03-15 has 11 BOOKED appointments
--     = 91.7% of the 12-slot cap  -> appears in the busy-days report;
--     a 12th booking still fits, a 13th is rejected (day full).
--   * Doctor 3 (Dr. Nana Owusu-Ansah): ZERO appointments -> appears with 0
--     in the doctors report (LEFT JOIN).
--   * Appointment 2: AP-002-style discount (paid 120.00 on a 150.00 fee).
--   * Appointment 12: CANCELLED in the SAME slot (2027-03-15 09:00) that
--     appointment 1 now holds -> proves a cancelled slot is re-bookable.
--   * Appointments 12 and 16: cancelled months ahead (> 48h notice),
--     so the policy gives a 100% refund.
--
-- Appointment dates are in 2027 (future, so they can be booked/cancelled in
-- the demo). booked_on / cancelled_at are HISTORY, so they are in the past
-- (November 2026): an event cannot have been recorded in the future.
-- All times are clinic wall-clock time (Africa/Johannesburg).
-- =====================================================================

USE medibook;

START TRANSACTION;

INSERT INTO patients (id, full_name, email, phone) VALUES
  ( 1, 'Ama Mensah',     'ama@mail.com',            '0244-111-222'),
  ( 2, 'Kojo Owusu',     'kojo@mail.com',           '0555-333-444'),
  ( 3, 'Esi Asante',     'esi.asante@mail.com',     '0201-555-666'),
  ( 4, 'Yaw Darko',      'yaw.darko@mail.com',      '0277-888-999'),
  ( 5, 'Abena Osei',     'abena.osei@mail.com',     '0246-123-456'),
  ( 6, 'Kwabena Addo',   'kwabena.addo@mail.com',   '0501-234-567'),
  ( 7, 'Efua Appiah',    'efua.appiah@mail.com',    '0262-345-678'),
  ( 8, 'Adwoa Sarpong',  'adwoa.sarpong@mail.com',  '0543-456-789'),
  ( 9, 'Kofi Antwi',     'kofi.antwi@mail.com',     '0209-567-890'),
  (10, 'Akua Frimpong',  'akua.frimpong@mail.com',  '0598-678-901'),
  (11, 'Kweku Badu',     'kweku.badu@mail.com',     '0240-789-012');

INSERT INTO doctors (id, full_name, specialty, consultation_fee, room) VALUES
  (1, 'Dr. Kwame Boateng',    'Dermatology', 150.00, 'R-12'),
  (2, 'Dr. Efua Adjei',       'Paediatrics', 100.00, 'R-03'),
  (3, 'Dr. Nana Owusu-Ansah', 'Cardiology',  250.00, 'R-07');

-- BOOKED appointments (no cancellation columns).
INSERT INTO appointments
  (id, appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES
  -- Doctor 1, busy day 2027-03-15: 11 BOOKED slots, 09:00 to 14:00.
  ( 1, 'AP-20270315-S001',  1, 1, '2027-03-15 09:00:00', 150.00, 'BOOKED', '2026-11-12 10:15:00'),
  ( 2, 'AP-20270315-S002',  2, 1, '2027-03-15 09:30:00', 120.00, 'BOOKED', '2026-11-02 09:05:00'),
  ( 3, 'AP-20270315-S003',  3, 1, '2027-03-15 10:00:00', 150.00, 'BOOKED', '2026-11-03 14:20:00'),
  ( 4, 'AP-20270315-S004',  4, 1, '2027-03-15 10:30:00', 150.00, 'BOOKED', '2026-11-04 08:45:00'),
  ( 5, 'AP-20270315-S005',  5, 1, '2027-03-15 11:00:00', 150.00, 'BOOKED', '2026-11-05 11:30:00'),
  ( 6, 'AP-20270315-S006',  6, 1, '2027-03-15 11:30:00', 150.00, 'BOOKED', '2026-11-06 16:00:00'),
  ( 7, 'AP-20270315-S007',  7, 1, '2027-03-15 12:00:00', 150.00, 'BOOKED', '2026-11-07 09:10:00'),
  ( 8, 'AP-20270315-S008',  8, 1, '2027-03-15 12:30:00', 150.00, 'BOOKED', '2026-11-08 13:40:00'),
  ( 9, 'AP-20270315-S009',  9, 1, '2027-03-15 13:00:00', 150.00, 'BOOKED', '2026-11-09 10:00:00'),
  (10, 'AP-20270315-S010', 10, 1, '2027-03-15 13:30:00', 150.00, 'BOOKED', '2026-11-10 15:25:00'),
  (11, 'AP-20270315-S011', 11, 1, '2027-03-15 14:00:00', 150.00, 'BOOKED', '2026-11-11 12:50:00'),
  -- Doctor 2.
  (13, 'AP-20270320-S013',  1, 2, '2027-03-20 10:00:00', 100.00, 'BOOKED', '2026-11-13 09:00:00'),
  (14, 'AP-20270320-S014',  3, 2, '2027-03-20 10:30:00', 100.00, 'BOOKED', '2026-11-14 10:30:00'),
  (15, 'AP-20270402-S015',  2, 2, '2027-04-02 11:00:00', 100.00, 'BOOKED', '2026-11-15 11:45:00');

-- CANCELLED appointments (cancellation + refund columns all set).
-- refund_amount = amount_paid * refund_percent / 100 (chk_appt_refund_matches_percent).
INSERT INTO appointments
  (id, appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status,
   booked_on, cancelled_at, refund_percent, refund_amount)
VALUES
  -- Same doctor + slot as appointment 1: allowed because active_slot is NULL here.
  -- Notice: 2026-11-10 16:45 -> 2027-03-15 09:00 is far more than 48h -> 100%.
  (12, 'AP-20270315-S012',  3, 1, '2027-03-15 09:00:00', 150.00, 'CANCELLED',
       '2026-11-01 08:30:00', '2026-11-10 16:45:00', 100, 150.00),
  -- Discounted booking cancelled with > 48h notice -> 100% of what was paid.
  (16, 'AP-20270322-S016',  4, 1, '2027-03-22 14:00:00', 120.00, 'CANCELLED',
       '2026-11-05 10:00:00', '2026-11-18 17:20:00', 100, 120.00);

COMMIT;
