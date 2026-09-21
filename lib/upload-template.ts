/**
 * The CSV shape the uploader accepts.
 *
 * Shared by `GET /api/upload` and the demo fixture, so the two cannot drift: a
 * demo visitor downloading the template must get the same column names the real
 * uploader will accept, or the demo teaches the wrong format.
 */

/** A ready-to-edit example file, including one parent/subsidiary pair. */
export const UPLOAD_TEMPLATE = [
  'name,amount,date,domain,industry,naics,parent',
  'Dell Technologies,125000.00,2024-03-01,dell.com,Computer manufacturing,334111,',
  'EMC Corporation,84000.50,2024-03-04,emc.com,Computer storage,334112,Dell Technologies',
  'Grainger,52300.00,2024-03-05,grainger.com,Industrial supplies,423840,',
].join('\n');

/** Accepted spellings for each logical column, so headers are forgiving. */
export const UPLOAD_ACCEPTED_COLUMNS: Record<string, string[]> = {
  name: ['name', 'supplier', 'supplier_name', 'vendor', 'company'],
  amount: ['amount', 'spend', 'total', 'value', 'invoice_amount'],
  date: ['date', 'transaction_date', 'invoice_date', 'posted_date'],
  domain: ['domain', 'website', 'url', 'supplier_domain'],
  industry: ['industry', 'sector'],
  naics: ['naics', 'naics_code'],
  parent: ['parent', 'parent_name', 'parent_company', 'ultimate_parent'],
};
