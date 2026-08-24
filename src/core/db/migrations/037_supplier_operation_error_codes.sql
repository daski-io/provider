ALTER TABLE supplier_operations
  ADD COLUMN error_code TEXT;

UPDATE supplier_operations
   SET error_code = CASE state
     WHEN 'ambiguous' THEN 'legacy.ambiguous'
     WHEN 'failed' THEN 'legacy.failed'
     ELSE NULL
   END
 WHERE state IN ('ambiguous', 'failed')
   AND error IS NOT NULL;

UPDATE supplier_operations
   SET error = NULL
 WHERE error IS NOT NULL;

ALTER TABLE supplier_operations
  DROP COLUMN error,
  ADD CONSTRAINT supplier_operations_error_code_format
    CHECK (
      error_code IS NULL
      OR (
        length(error_code) BETWEEN 3 AND 64
        AND error_code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'
      )
    );
