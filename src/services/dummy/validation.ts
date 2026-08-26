export function parseMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error("message must be a string");
  const message = value.trim();
  const length = [...message].length;
  if (length < 1 || length > 500) {
    throw new Error("message must contain between 1 and 500 Unicode code points");
  }
  return message;
}
