-- MediBook database schema (MySQL 8.0+, InnoDB, utf8mb4).
--
-- Exactly 3 tables, created in an order the foreign keys allow: patients,
-- doctors, then appointments. The columns, types and constraint names match
-- schema-diagram.png, docs/schema.dbml and docs/schema-diagram.md.
--
-- Run it as root (or another account that can drop and create databases).
-- Careful: it deletes the medibook database and builds it again from scratch.

DROP DATABASE IF EXISTS medibook;
CREATE DATABASE medibook
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE medibook;

-- patients: one row per person. In the spreadsheet a patient's name, email
-- and phone were repeated on every appointment row.
CREATE TABLE patients (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  full_name  VARCHAR(100)  NOT NULL,
  email      VARCHAR(254)  NOT NULL,
  phone      VARCHAR(20)   NOT NULL,

  CONSTRAINT pk_patients                PRIMARY KEY (id),
  CONSTRAINT uq_patient_email           UNIQUE (email),
  CONSTRAINT chk_patient_name_not_blank CHECK (CHAR_LENGTH(TRIM(full_name)) > 0),
  CONSTRAINT chk_patient_email_format   CHECK (email LIKE '%_@_%._%'),
  CONSTRAINT chk_patient_phone_format   CHECK (REGEXP_LIKE(phone, '^[+]?[0-9][0-9 ()-]{5,18}[0-9]$'))
) ENGINE = InnoDB;

-- doctors: specialty, fee and room depend only on the doctor, so they're
-- stored once here instead of on every appointment.
CREATE TABLE doctors (
  id                INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  full_name         VARCHAR(100)   NOT NULL,
  specialty         VARCHAR(80)    NOT NULL,
  consultation_fee  DECIMAL(10,2)  NOT NULL,
  room              VARCHAR(10)    NOT NULL,

  CONSTRAINT pk_doctors                     PRIMARY KEY (id),
  CONSTRAINT uq_doctor_room                 UNIQUE (room),
  CONSTRAINT chk_doctor_name_not_blank      CHECK (CHAR_LENGTH(TRIM(full_name)) > 0),
  CONSTRAINT chk_doctor_specialty_not_blank CHECK (CHAR_LENGTH(TRIM(specialty)) > 0),
  CONSTRAINT chk_doctor_room_not_blank      CHECK (CHAR_LENGTH(TRIM(room)) > 0),
  CONSTRAINT chk_doctor_fee_positive        CHECK (consultation_fee > 0)
) ENGINE = InnoDB;

-- appointments: one patient with one doctor at one slot.
-- We're only allowed 3 tables, so the cancellation and refund details are
-- columns here. A cancelled row is never deleted; it's the refund history.
--
-- active_slot is a stored generated column:
--   status = 'BOOKED'    -> active_slot = appt_datetime
--   status = 'CANCELLED' -> active_slot = NULL
-- So UNIQUE (doctor_id, active_slot) stops two booked rows for the same doctor
-- and slot. Cancelled rows all have NULL there, and a UNIQUE index never treats
-- two NULLs as equal, so a cancelled slot can be booked again straight away.
CREATE TABLE appointments (
  id              INT UNSIGNED                 NOT NULL AUTO_INCREMENT,
  appt_ref        VARCHAR(16)                  NOT NULL,
  patient_id      INT UNSIGNED                 NOT NULL,
  doctor_id       INT UNSIGNED                 NOT NULL,
  appt_datetime   DATETIME                     NOT NULL,
  amount_paid     DECIMAL(10,2)                NOT NULL,
  status          ENUM('BOOKED','CANCELLED')   NOT NULL DEFAULT 'BOOKED',
  active_slot     DATETIME GENERATED ALWAYS AS
                    (CASE WHEN status = 'BOOKED' THEN appt_datetime ELSE NULL END) STORED,
  booked_on       DATETIME                     NOT NULL,
  cancelled_at    DATETIME                     NULL,
  refund_percent  TINYINT UNSIGNED             NULL,
  refund_amount   DECIMAL(10,2)                NULL,

  CONSTRAINT pk_appointments PRIMARY KEY (id),
  CONSTRAINT uq_appt_ref     UNIQUE (appt_ref),

  -- A doctor can never have two active appointments at the same date and time.
  CONSTRAINT uq_appt_doctor_active_slot  UNIQUE (doctor_id, active_slot),
  -- A patient can't be booked in two places at the same date and time either.
  CONSTRAINT uq_appt_patient_active_slot UNIQUE (patient_id, active_slot),

  CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES patients (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_appt_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctors (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Slots start on the hour or half hour, with no seconds, from 09:00 to 16:30 (the last start).
  CONSTRAINT chk_appt_slot_minutes  CHECK (MINUTE(appt_datetime) IN (0, 30)),
  CONSTRAINT chk_appt_slot_seconds  CHECK (SECOND(appt_datetime) = 0),
  CONSTRAINT chk_appt_working_hours CHECK (TIME(appt_datetime) BETWEEN '09:00:00' AND '16:30:00'),

  -- The reference looks like AP-20270315-K7Q2. The 'c' makes the match case-sensitive.
  CONSTRAINT chk_appt_ref_format CHECK (REGEXP_LIKE(appt_ref, '^AP-[0-9]{8}-[0-9A-Z]{4}$', 'c')),

  -- Money rules.
  CONSTRAINT chk_appt_amount_paid_non_negative CHECK (amount_paid >= 0),
  CONSTRAINT chk_appt_refund_percent_range     CHECK (refund_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_appt_refund_within_paid       CHECK (refund_amount BETWEEN 0 AND amount_paid),
  CONSTRAINT chk_appt_refund_matches_percent   CHECK (refund_amount = ROUND(amount_paid * refund_percent / 100, 2)),

  -- A booked row has no cancellation details at all. A cancelled row must have
  -- all of them, so a cancellation can't be saved without its refund.
  CONSTRAINT chk_appt_status_consistency CHECK (
       (status = 'BOOKED'    AND cancelled_at IS NULL     AND refund_percent IS NULL     AND refund_amount IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND refund_percent IS NOT NULL AND refund_amount IS NOT NULL)
  ),

  -- Dates in the right order: booked before the slot, cancelled after booking.
  CONSTRAINT chk_appt_booked_before_slot     CHECK (booked_on < appt_datetime),
  CONSTRAINT chk_appt_cancelled_after_booked CHECK (cancelled_at >= booked_on),

  -- Speeds up counting a doctor's bookings per day, for booking and for the reports.
  INDEX idx_appt_doctor_datetime (doctor_id, appt_datetime)
) ENGINE = InnoDB;
