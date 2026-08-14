// @requires
const plan = $input.first();
const rows = (plan && plan.json && plan.json.emaillog_rows) || [];
return rows.map((json) => ({ json }));
