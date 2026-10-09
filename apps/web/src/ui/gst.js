/**
 * The government's own taxpayer search (https://services.gst.gov.in/services/searchtp) is protected by a captcha and a bot-defence
 * script, so a server cannot query it; a person can. This copies the GSTIN to the clipboard and opens that page in a new tab, so the
 * name, status and address can be checked on the official site and typed or pasted back here.
 */
export const GST_PORTAL_SEARCH = 'https://services.gst.gov.in/services/searchtp';
export async function openGstPortal(gstin) {
  try { await navigator.clipboard.writeText(String(gstin ?? '').trim().toUpperCase()); } catch { /* the clipboard is optional */ }
  window.open(GST_PORTAL_SEARCH, '_blank', 'noopener,noreferrer');
}
