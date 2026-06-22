import { HttpError } from "./http.js";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

const PHONE_VALIDATION_MESSAGE =
  "Enter a valid phone number. Use 10 digits for US/Canada, or + and country code for international numbers.";
const SUPPORTED_SMS_COUNTRY_CODES = new Set(["US", "CA"]);

function getPhoneCandidate(raw, digits, withPlus) {
  if (withPlus) {
    return `+${digits}`;
  }

  if (digits.startsWith("00") && digits.length > 2) {
    return `+${digits.slice(2)}`;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  throw new HttpError(400, PHONE_VALIDATION_MESSAGE);
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) {
    return null;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }

  return email;
}

export function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const withPlus = raw.startsWith("+");
  let digits = raw.replace(/[^\d]/g, "");
  if (!digits) {
    throw new HttpError(400, "Enter a valid phone number.");
  }

  const candidate = getPhoneCandidate(raw, digits, withPlus);
  const phoneNumber = parsePhoneNumberFromString(candidate);
  if (!phoneNumber?.isValid()) {
    throw new HttpError(400, PHONE_VALIDATION_MESSAGE);
  }

  return phoneNumber.number;
}

export function getPhoneCountry(value) {
  const phone = normalizePhone(value);
  if (!phone) {
    return null;
  }

  return parsePhoneNumberFromString(phone)?.country || null;
}

export function isSupportedSmsPhone(value) {
  const country = getPhoneCountry(value);
  return SUPPORTED_SMS_COUNTRY_CODES.has(country);
}

export function getPhoneCountryName(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!code) {
    return "an unsupported country";
  }

  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(code) || code;
  } catch {
    return code;
  }
}

export function normalizeSignupContacts(payload) {
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.phone);
  const smsConsent = Boolean(payload.smsConsent);

  if (!email && !phone) {
    throw new HttpError(400, "Enter an email address, a phone number, or both.");
  }

  if (phone && !smsConsent) {
    throw new HttpError(400, "SMS consent is required before subscribing a phone number.");
  }

  return {
    email,
    phone,
    smsConsent,
    wantsEmail: Boolean(email),
    wantsSms: Boolean(phone),
  };
}
