// @requires
// Fan-out helper: turns the plan node's `applicant_rows` into sheet items.
// Emitting zero items simply stops this branch, which is the correct no-op.
const plan = $input.first();
const rows = (plan && plan.json && plan.json.applicant_rows) || [];
return rows.map((json) => ({ json }));
