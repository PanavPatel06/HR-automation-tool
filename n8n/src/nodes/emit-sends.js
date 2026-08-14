// @requires
// One item per email that is actually going out. Empty on a dry run, which is
// how the Gmail node is skipped without a branch.
const plan = $input.first();
const rows = (plan && plan.json && plan.json.send_items) || [];
return rows.map((json) => ({ json }));
