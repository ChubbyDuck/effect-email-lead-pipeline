import { inboxDefaults as realInbox } from '../inbox';
import { leadDefaults as realLeads } from '../leads';
import { sliceDefaults as realSlice, sourceDefaults as realSources } from '../sources';

/**
 * Round timings for the tests of the arithmetic of the model. The real defaults are measurements, and each new
 * measurement changes them, so a test of a calculation must not depend on them.
 */
const roundInbox = {
  delay_in: 25,
  in_request_ledger_acknowledge_t: 20,
  in_storage_read_t: 200,
  in_email_parser_parse_t: 80,
  in_storage_store_t: 120,
  in_storage_delete_t: 40,
  in_request_ledger_record_t: 20,
  in_init_t: 400,
};

const roundSources = {
  delay_src: 25,
  src_storage_read_t: 200,
  src_excel_sheet_parser_parse_t: 150,
  src_queue_push_t: 120,
  src_storage_delete_t: 40,
  src_init_t: 400,
};

const roundLeads = {
  delay_ld: 25,
  ld_records_parse_t: 20,
  ld_order_repository_store_t: 20,
  ld_request_ledger_record_t: 20,
  ld_init_t: 400,
};

export const inboxDefaults = { ...realInbox, ...roundInbox };
export const sourceDefaults = { ...realSources, ...roundSources };
export const leadDefaults = { ...realLeads, ...roundLeads };
export const sliceDefaults = { ...realSlice, ...roundInbox, ...roundSources, ...roundLeads };
