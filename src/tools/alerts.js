import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete alerts via REST API. Pass alert_ids array OR delete_all:true.', {
    delete_all: z.coerce.boolean().optional().describe('Delete every active alert'),
    alert_ids: z.array(z.coerce.number()).optional().describe('Specific alert IDs to delete (from alert_list)'),
  }, async ({ delete_all, alert_ids }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all, alert_ids })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
