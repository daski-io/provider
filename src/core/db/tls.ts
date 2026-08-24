export type DatabaseSslMode = "disable" | "require" | "verify-full";

export interface DatabaseTlsConfig {
  rejectUnauthorized: boolean;
  ca?: string;
}

export function databaseTlsConfig(
  mode: DatabaseSslMode,
  caCert?: string,
): DatabaseTlsConfig | undefined {
  if (mode === "disable") return undefined;
  if (mode === "require") return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ...(caCert ? { ca: caCert.replace(/\\n/g, "\n") } : {}),
  };
}

export function parseDatabaseSslMode(value: string | undefined): DatabaseSslMode {
  if (value === "disable" || value === "require" || value === "verify-full") {
    return value;
  }
  throw new Error(
    "DATABASE_SSL_MODE must be explicitly set to disable, require, or verify-full",
  );
}

export function assertVerifiedTlsForDatabaseMutation(
  connectionString: string,
  mode: DatabaseSslMode,
): void {
  const hostname = new URL(connectionString).hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
  if (!loopback && mode !== "verify-full") {
    throw new Error(
      "Remote database mutations require DATABASE_SSL_MODE=verify-full",
    );
  }
}
