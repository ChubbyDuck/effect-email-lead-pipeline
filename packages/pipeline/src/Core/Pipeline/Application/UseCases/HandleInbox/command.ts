export type Command = {
  readonly bucket: string;
  /** The key of the email. The handler reads the request ID from it, so the ID and the key cannot disagree. */
  readonly key: string;
  /** When S3 stored the email. It sets the folder, so a second delivery uses the same folder. */
  readonly receivedAt: Date;
  readonly functionName: string;
};
