import { Schema } from 'effect';
import { expect, test } from 'vitest';

import {
  cellText,
  CoercedStringWithoutNull,
  ExcelDateValue,
  formatLocalIsoDate,
  optionalCoercedString,
  sanitizer,
} from './schemas';

test('optionalCoercedString keeps undefined instead of stringifying it', () => {
  const Extracted = Schema.Struct({ name: optionalCoercedString });
  expect(Schema.decodeSync(Extracted)({ name: undefined })).toEqual({ name: undefined });
  expect(Schema.decodeSync(Extracted)({})).toEqual({});
  expect(Schema.decodeSync(Extracted)({ name: 12 })).toEqual({ name: '12' });
});

test('CoercedStringWithoutNull turns null into an empty string and keeps the text of each primitive', () => {
  expect(Schema.decodeSync(CoercedStringWithoutNull)(null)).toBe('');
  expect(Schema.decodeSync(CoercedStringWithoutNull)(12)).toBe('12');
  expect(Schema.decodeSync(CoercedStringWithoutNull)('already')).toBe('already');
});

test('cellText keeps the text of each primitive, writes a date as its ISO date, and gives no text for an object', () => {
  expect(cellText('  as is ')).toBe('  as is ');
  expect(cellText(12.5)).toBe('12.5');
  expect(cellText(false)).toBe('false');
  expect(cellText(10n)).toBe('10');
  expect(cellText(new Date(2024, 0, 15))).toBe('2024-01-15');
  expect(cellText({ richText: [{ text: 'bold' }] })).toBeUndefined();
  expect(cellText(['a'])).toBeUndefined();
  expect(cellText(null)).toBeUndefined();
  expect(cellText(undefined)).toBeUndefined();
});

test('CoercedStringWithoutNull writes a date as its ISO date and an object as an empty cell', () => {
  expect(Schema.decodeSync(CoercedStringWithoutNull)(new Date(2024, 0, 15))).toBe('2024-01-15');
  expect(Schema.decodeSync(CoercedStringWithoutNull)({ richText: [{ text: 'bold' }] })).toBe('');
});

test('sanitizer drops a cell that is an object, as an empty cell', () => {
  expect(Schema.decodeSync(sanitizer)({ a: { richText: [{ text: 'bold' }] }, b: ' 12 ', c: 7 })).toEqual({
    b: '12',
    c: '7',
  });
  expect(Schema.decodeSync(sanitizer)({ a: { richText: [] }, b: null })).toBeNull();
});

test('ExcelDateValue formats Date values as local ISO dates and leaves other cells alone', () => {
  const date = new Date(2024, 0, 15);
  expect(Schema.decodeSync(ExcelDateValue)(date)).toBe('2024-01-15');
  expect(Schema.decodeSync(ExcelDateValue)('unbekannt')).toBe('unbekannt');
  expect(formatLocalIsoDate(date)).toBe('2024-01-15');
});

test('sanitizer drops empty cells and returns null when nothing remains', () => {
  const date = new Date(2024, 5, 1);
  expect(
    Schema.decodeSync(sanitizer)({
      a: null,
      b: 'K.A.',
      c: '.',
      d: '  hi  ',
      e: date,
    })
  ).toEqual({ d: 'hi', e: date });
  expect(Schema.decodeSync(sanitizer)({ a: '', b: null })).toBeNull();
});
