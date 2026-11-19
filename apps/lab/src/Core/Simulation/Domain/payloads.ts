import type { SliceInputs } from './sources';

/** Headers and the body text of one email. An estimate. */
export const emailHeaderBytes = 4096;

/** S3 and Lambda count a megabyte in binary units. */
export const megabyteBytes = 1024 ** 2;

/** Bytes as megabytes, rounded for a formula. */
export const inMegabytes = (bytes: number) => Number((bytes / megabyteBytes).toFixed(2));

/** One attachment as MIME carries it: base64, in lines of 76 characters and a CRLF. */
export function base64Bytes(bytes: number) {
  const encoded = Math.ceil(bytes / 3) * 4;
  return encoded + Math.ceil(encoded / 76) * 2;
}

/** One workbook as the inbox stores it on the sources bucket: L rows at `row_b` bytes, decoded from base64. */
export function workbookBytes(input: Pick<SliceInputs, 'L' | 'row_b'>) {
  return input.L * input.row_b;
}

/** One email: headers, then S workbooks of L rows at `row_b` bytes, each base64 encoded. */
export function emailBytes(input: Pick<SliceInputs, 'S' | 'L' | 'row_b'>) {
  return emailHeaderBytes + input.S * base64Bytes(workbookBytes(input));
}
