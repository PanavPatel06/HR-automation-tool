// @requires
const plan = $input.first();
const rows = (plan && plan.json && plan.json.reply_rows) || [];
return rows.map((json) => ({ json }));
