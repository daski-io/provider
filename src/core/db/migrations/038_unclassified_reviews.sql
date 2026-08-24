-- 'legacy_review' implied old code or pre-launch data; it actually marks any
-- escalation whose creator did not classify it. Rename to say what it means.
-- The open-reviews dedupe index and typed-open-reviews CHECK are unaffected
-- (dedupe keys keep their historical values; the CHECK only requires the
-- fields to be present).
UPDATE escalations
   SET review_kind = 'unclassified_review'
 WHERE review_kind = 'legacy_review';

UPDATE escalations
   SET review_kind = 'unclassified_screening_review'
 WHERE review_kind = 'legacy_screening_review';
