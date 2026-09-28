-- Pre-beta hardening.
--
--  * processing_owner: which worker holds the conversation lease. Workers renew
--    and release only their own lease, so a slow worker can never clear or
--    extend a lease another worker has taken over.

alter table conversations add column processing_owner uuid;
