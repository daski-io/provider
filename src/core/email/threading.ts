// thread_root normalization. The root is the earliest Message-ID we
// can derive from a mail's headers; falls back to In-Reply-To or the
// email's own Message-ID. Used to group conversations across multiple
// inbound emails on the same thread.

export function computeThreadRoot(args: {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
}): string {
  const references = args.references.map(normalizeMessageId).filter(Boolean);
  if (references.length > 0) {
    // The earliest reference (first in the chain) is the thread root.
    return references[0];
  }
  if (args.inReplyTo) return normalizeMessageId(args.inReplyTo);
  return normalizeMessageId(args.messageId);
}

export function normalizeMessageId(value: string): string {
  const bracketed = value.match(/<[^<>\s]{1,998}>/);
  if (bracketed) return bracketed[0].toLowerCase();
  const trimmed = value.trim().slice(0, 998);
  return trimmed.toLowerCase();
}
