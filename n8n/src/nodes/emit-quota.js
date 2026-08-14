// @requires
const plan = $input.first();
const rows = (plan && plan.json && plan.json.quota_rows) || [];
return rows.map((json) => ({ json }));
