DROP INDEX operator_chats_thread_idx;

CREATE INDEX operator_chats_thread_idx
  ON operator_chats(thread_id, created_at DESC, id DESC);
