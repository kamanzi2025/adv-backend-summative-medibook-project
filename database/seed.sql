-- MediBook sample data. Run it after schema.sql.
--
-- The ids are set by hand and the tables are filled in foreign-key order
-- (patients, doctors, appointments). It all runs in one transaction, so either
-- the whole seed loads or none of it does.
--
-- What the data is there to show:
--   * Doctor 1 (Dr. Kwame Boateng) has 11 booked appointments on 2027-03-15.
--     That's 91.7% of the 12-slot cap, so the day shows up in the busy-days
--     report. A 12th booking still fits; a 13th is refused because the day is full.
--   * Doctor 3 (Dr. Nana Owusu-Ansah) has no appointments at all, and still
--     appears in the doctors report with 0 (that's what the LEFT JOIN is for).
--   * Appointment 2 has a discount like AP-002 in the spreadsheet: 120.00 paid on a 150.00 fee.
--   * Appointment 12 was cancelled in the same slot (2027-03-15 09:00) that
--     appointment 1 holds now, which shows a cancelled slot can be booked again.
--   * Appointments 12 and 16 were cancelled months ahead, well over 48 hours'
--     notice, so they got a 100% refund.
--
-- The appointments are in 2027 so they're still in the future and can be booked
-- or cancelled during the demo. booked_on and cancelled_at record things that
-- already happened, so they're in the past (November 2026).
-- All times are clinic wall-clock time (Africa/Johannesburg).

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

-- Booked appointments, so the cancellation columns stay empty.
INSERT INTO appointments
  (id, appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status, booked_on)
VALUES
  -- Doctor 1's busy day, 2027-03-15: 11 booked slots from 09:00 to 14:00.
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

-- Cancelled appointments, with every cancellation and refund column filled in.
-- refund_amount has to equal amount_paid * refund_percent / 100 (chk_appt_refund_matches_percent).
INSERT INTO appointments
  (id, appt_ref, patient_id, doctor_id, appt_datetime, amount_paid, status,
   booked_on, cancelled_at, refund_percent, refund_amount)
VALUES
  -- Same doctor and slot as appointment 1. That's allowed because active_slot is NULL here.
  -- Cancelled on 2026-11-10 for 2027-03-15, far more than 48 hours ahead, so 100%.
  (12, 'AP-20270315-S012',  3, 1, '2027-03-15 09:00:00', 150.00, 'CANCELLED',
       '2026-11-01 08:30:00', '2026-11-10 16:45:00', 100, 150.00),
  -- A discounted booking cancelled more than 48 hours ahead: 100% of what was paid back.
  (16, 'AP-20270322-S016',  4, 1, '2027-03-22 14:00:00', 120.00, 'CANCELLED',
       '2026-11-05 10:00:00', '2026-11-18 17:20:00', 100, 120.00);

COMMIT;
