import type { MoneyAllocation } from '../types';

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export const getCurrencyFractionDigits = (currency: string): number | null => {
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    return null;
  }

  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return null;
  }
};

export const parseDecimalToMinorUnits = (
  rawValue: string,
  currency: string,
): number | null => {
  const fractionDigits = getCurrencyFractionDigits(currency);
  if (fractionDigits === null) {
    return null;
  }

  const value = rawValue.trim();
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const fraction = match[2] ?? '';
  if (fraction.length > fractionDigits) {
    return null;
  }

  const minorText =
    `${match[1]}${fraction.padEnd(fractionDigits, '0')}`.replace(
      /^0+(?=\d)/,
      '',
    ) || '0';

  try {
    const minor = BigInt(minorText);
    if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return Number(minor);
  } catch {
    return null;
  }
};

export const allocateEqualShares = (
  amountMinor: number,
  participantIds: string[],
): MoneyAllocation[] => {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    participantIds.length === 0 ||
    new Set(participantIds).size !== participantIds.length
  ) {
    return [];
  }

  const base = Math.floor(amountMinor / participantIds.length);
  const remainder = amountMinor % participantIds.length;

  return participantIds.map((participantId, index) => ({
    participantId,
    amountMinor: base + (index < remainder ? 1 : 0),
  }));
};

export const formatMinorUnits = (
  amountMinor: number,
  currency: string,
  locale?: string,
): string => {
  const fractionDigits = getCurrencyFractionDigits(currency) ?? 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: CURRENCY_CODE_PATTERN.test(currency) ? currency : 'USD',
  }).format(amountMinor / 10 ** fractionDigits);
};

export const minorUnitsToMajor = (
  amountMinor: number,
  currency: string,
): number => {
  const fractionDigits = getCurrencyFractionDigits(currency) ?? 2;
  return amountMinor / 10 ** fractionDigits;
};

export const minorUnitsToDecimalString = (
  amountMinor: number,
  currency: string,
): string => {
  const fractionDigits = getCurrencyFractionDigits(currency) ?? 2;
  if (fractionDigits === 0) {
    return amountMinor.toString();
  }
  const factor = 10 ** fractionDigits;
  const whole = Math.floor(amountMinor / factor);
  const fraction = `${amountMinor % factor}`.padStart(fractionDigits, '0');
  return `${whole}.${fraction}`;
};

export const formatLocalCalendarDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const parseLocalCalendarDate = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
};
