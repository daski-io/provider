-- Optional provider screening extensions use a service-neutral review source.
ALTER TABLE escalations DROP CONSTRAINT escalations_source_check;
ALTER TABLE escalations ADD CONSTRAINT escalations_source_check CHECK (
  source IN (
    'pre_execute','email_agent','operator','auto','fulfillment_hold','screening'
  )
);
