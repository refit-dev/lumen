-- 0001_initial_schema.sql
-- Initial QuestDB schema migration for events table

CREATE TABLE IF NOT EXISTS events (
  event_timestamp TIMESTAMP,
  merchant_id      SYMBOL,
  customer_id      SYMBOL,
  ext_customer_id  SYMBOL,
  event_name       SYMBOL,
  event_value      DOUBLE,
  event_string     VARCHAR,
  idempotency_key  VARCHAR,
  properties       VARCHAR
) TIMESTAMP(event_timestamp) PARTITION BY DAY WAL
DEDUP UPSERT KEYS(event_timestamp, merchant_id, idempotency_key);