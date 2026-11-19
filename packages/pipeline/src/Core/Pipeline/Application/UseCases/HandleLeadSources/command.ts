export type Command = {
  readonly bucket: string;
  /** The key of the workbook. The handler reads the request ID from it, so the ID and the key cannot disagree. */
  readonly key: string;
  readonly functionName: string;
};
