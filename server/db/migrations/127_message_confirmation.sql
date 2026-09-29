ALTER TABLE ozon_message_records ADD COLUMN confirmed_message_fingerprint TEXT;
CREATE UNIQUE INDEX ozon_message_confirmed_message
  ON ozon_message_records(account_id,store_id,confirmed_message_fingerprint)
  WHERE confirmed_message_fingerprint IS NOT NULL;
