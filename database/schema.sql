-- =====================================================================
-- MediBook: database schema (MySQL 8.0+, InnoDB, utf8mb4)
-- Exactly 3 tables, in FK-safe order: patients, doctors, appointments.
-- Must match docs/schema.dbml and docs/schema-diagram.md exactly
-- (same columns, types and constraint names).
--
-- Run as root (or any account allowed to DROP/CREATE DATABASE).
-- WARNING: drops and re-creates the medibook database.
-- =====================================================================

DROP DATABASE IF EXISTS medibook;
CREATE DATABASE medibook
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE medibook;

-- ---------------------------------------------------------------------
-- patients: one row per person (removes the repeated patient columns
-- from the spreadsheet).
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- doctors: specialty, fee and room depend only on the doctor, so they
-- live here, not on every appointment.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- appointments: links one patient to one doctor at one slot.
-- Cancellation + refund data are COLUMNS here (no extra tables allowed);
-- a cancelled row is kept forever as refund history.
--
-- active_slot is a STORED generated column:
--   status = 'BOOKED'    -> active_slot = appt_datetime
--   status = 'CANCELLED' -> active_slot = NULL
-- UNIQUE (doctor_id, active_slot) therefore blocks two BOOKED rows for
-- the same doctor + slot, while any number of CANCELLED rows (NULL never
-- equals NULL in a UNIQUE index) can share that slot, so a cancelled slot
-- is immediately re-bookable.
-- ---------------------------------------------------------------------
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

  -- Business rule: a doctor can never have two ACTIVE appointments at the same date/time.
  CONSTRAINT uq_appt_doctor_active_slot  UNIQUE (doctor_id, active_slot),
  -- Business rule: a patient can never hold two ACTIVE appointments at the same date/time.
  CONSTRAINT uq_appt_patient_active_slot UNIQUE (patient_id, active_slot),

  CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES patients (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_appt_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctors (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Slot shape: 30-minute boundaries, whole minutes, 09:00 to 16:30 (last start).
  CONSTRAINT chk_appt_slot_minutes  CHECK (MINUTE(appt_datetime) IN (0, 30)),
  CONSTRAINT chk_appt_slot_seconds  CHECK (SECOND(appt_datetime) = 0),
  CONSTRAINT chk_appt_working_hours CHECK (TIME(appt_datetime) BETWEEN '09:00:00' AND '16:30:00'),

  -- Format of the human-readable reference, e.g. AP-20270315-K7Q2 (case-sensitive match).
  CONSTRAINT chk_appt_ref_format CHECK (REGEXP_LIKE(appt_ref, '^AP-[0-9]{8}-[0-9A-Z]{4}$', 'c')),

  -- Money.
  CONSTRAINT chk_appt_amount_paid_non_negative CHECK (amount_paid >= 0),
  CONSTRAINT chk_appt_refund_percent_range     CHECK (refund_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_appt_refund_within_paid       CHECK (refund_amount BETWEEN 0 AND amount_paid),
  CONSTRAINT chk_appt_refund_matches_percent   CHECK (refund_amount = ROUND(amount_paid * refund_percent / 100, 2)),

  -- Status consistency: BOOKED rows carry no cancellation data,
  -- CANCELLED rows must carry ALL of it (cancellation + refund together).
  CONSTRAINT chk_appt_status_consistency CHECK (
       (status = 'BOOKED'    AND cancelled_at IS NULL     AND refund_percent IS NULL     AND refund_amount IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND refund_percent IS NOT NULL AND refund_amount IS NOT NULL)
  ),

  -- Timeline: booked before the slot starts; cancelled after it was booked.
  CONSTRAINT chk_appt_booked_before_slot     CHECK (booked_on < appt_datetime),
  CONSTRAINT chk_appt_cancelled_after_booked CHECK (cancelled_at >= booked_on),

  -- Speeds up the per-doctor per-day counts used by booking and the reports.
  INDEX idx_appt_doctor_datetime (doctor_id, appt_datetime)
) ENGINE = InnoDB;
